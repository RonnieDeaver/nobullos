import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  index,
  unique,
  uniqueIndex,
  date,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";

export const bookingPages = pgTable(
  "booking_pages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Exactly one booking page per AM (Task #840 spec). Enforced at the DB
     // level so two concurrent "create page" requests can't slip a duplicate
     // through.
    accountManagerUserId: varchar("account_manager_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    timezone: varchar("timezone").notNull().default("America/Chicago"),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    active: boolean("active").notNull().default(true),
    // Per-page opt-in for recurring bookings on the PUBLIC surface
    // (Task #1032E). Internal staff bookings via the AM-on-behalf
    // endpoint are NOT gated by this flag — only public confirms.
    allowRecurring: boolean("allow_recurring").notNull().default(false),
    title: text("title"),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    amIdx: index("booking_pages_am_idx").on(table.accountManagerUserId),
    slugIdx: index("booking_pages_slug_idx").on(table.slug),
  }),
);

export const insertBookingPageSchema = createInsertSchema(bookingPages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBookingPage = z.infer<typeof insertBookingPageSchema>;
export type BookingPage = typeof bookingPages.$inferSelect;

// Task #4380 (F8 storage-boundary closure): focused update schema for
// bookingStorage.updateBookingPage. Ownership (accountManagerUserId) is
// fixed at create and stays out of the patch; unknown keys strip.
export const updateBookingPageSchema = insertBookingPageSchema
  .omit({ accountManagerUserId: true })
  .partial();
export type UpdateBookingPage = z.infer<typeof updateBookingPageSchema>;

export const bookingAvailabilityRules = pgTable(
  "booking_availability_rules",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    bookingPageId: varchar("booking_page_id")
      .references(() => bookingPages.id, { onDelete: "cascade" })
      .notNull(),
    dayOfWeek: integer("day_of_week").notNull(), // 0 = Sunday … 6 = Saturday
    startTimeLocal: varchar("start_time_local", { length: 5 }).notNull(), // "HH:MM" 24h
    endTimeLocal: varchar("end_time_local", { length: 5 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    pageIdx: index("booking_avail_rules_page_idx").on(table.bookingPageId),
    pageDayIdx: index("booking_avail_rules_page_day_idx").on(
      table.bookingPageId,
      table.dayOfWeek,
    ),
  }),
);

export const insertBookingAvailabilityRuleSchema = createInsertSchema(
  bookingAvailabilityRules,
).omit({ id: true, createdAt: true });
export type InsertBookingAvailabilityRule = z.infer<
  typeof insertBookingAvailabilityRuleSchema
>;
export type BookingAvailabilityRule = typeof bookingAvailabilityRules.$inferSelect;

export const bookingAvailabilityOverrides = pgTable(
  "booking_availability_overrides",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    bookingPageId: varchar("booking_page_id")
      .references(() => bookingPages.id, { onDelete: "cascade" })
      .notNull(),
    dateLocal: date("date_local").notNull(), // YYYY-MM-DD in the page's tz
    isBlocked: boolean("is_blocked").notNull().default(false),
    customStartTimeLocal: varchar("custom_start_time_local", { length: 5 }),
    customEndTimeLocal: varchar("custom_end_time_local", { length: 5 }),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    pageIdx: index("booking_avail_overrides_page_idx").on(table.bookingPageId),
    uniquePageDate: unique("booking_avail_overrides_page_date_unique").on(
      table.bookingPageId,
      table.dateLocal,
    ),
  }),
);

export const insertBookingAvailabilityOverrideSchema = createInsertSchema(
  bookingAvailabilityOverrides,
).omit({ id: true, createdAt: true });
export type InsertBookingAvailabilityOverride = z.infer<
  typeof insertBookingAvailabilityOverrideSchema
>;
export type BookingAvailabilityOverride =
  typeof bookingAvailabilityOverrides.$inferSelect;

export const bookingMeetingTypes = pgTable(
  "booking_meeting_types",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    accountManagerUserId: varchar("account_manager_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    amIdx: index("booking_meeting_types_am_idx").on(table.accountManagerUserId),
    amNameUnique: unique("booking_meeting_types_am_name_unique").on(
      table.accountManagerUserId,
      table.name,
    ),
  }),
);

export const insertBookingMeetingTypeSchema = createInsertSchema(
  bookingMeetingTypes,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBookingMeetingType = z.infer<
  typeof insertBookingMeetingTypeSchema
>;
export type BookingMeetingType = typeof bookingMeetingTypes.$inferSelect;

// Task #4380: focused update schema for bookingStorage.updateBookingMeetingType.
// Ownership (accountManagerUserId) is fixed at create and stays out.
export const updateBookingMeetingTypeSchema = insertBookingMeetingTypeSchema
  .omit({ accountManagerUserId: true })
  .partial();
export type UpdateBookingMeetingType = z.infer<
  typeof updateBookingMeetingTypeSchema
>;

export const scheduledMeetingStatuses = [
  "creating",
  "confirmed",
  "failed",
  "canceled",
] as const;
export type ScheduledMeetingStatus = (typeof scheduledMeetingStatuses)[number];

export const bookingSources = [
  "client_profile",
  "public_link",
  "client_bound_public_link",
] as const;
export type BookingSource = (typeof bookingSources)[number];

export const scheduledMeetings = pgTable(
  "scheduled_meetings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: varchar("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    accountManagerUserId: varchar("account_manager_user_id")
      .references(() => users.id, { onDelete: "set null" }),
    bookingPageId: varchar("booking_page_id").references(() => bookingPages.id, {
      onDelete: "set null",
    }),
    meetingTypeId: varchar("meeting_type_id").references(
      () => bookingMeetingTypes.id,
      { onDelete: "set null" },
    ),
    meetingTypeName: text("meeting_type_name"),
    bookingSource: varchar("booking_source").notNull(),
    inviteeName: text("invitee_name"),
    inviteeEmail: text("invitee_email"),
    startTimeUtc: timestamp("start_time_utc").notNull(),
    endTimeUtc: timestamp("end_time_utc").notNull(),
    timezone: varchar("timezone").notNull(),
    status: varchar("status").notNull().default("creating"),
    failureReason: text("failure_reason"),
    // Stored as canonical normalized string (digits only) for deterministic lookup.
    zoomMeetingId: varchar("zoom_meeting_id"),
    zoomMeetingUuid: varchar("zoom_meeting_uuid"),
    zoomJoinUrl: text("zoom_join_url"),
    zoomStartUrl: text("zoom_start_url"),
    zoomHostUserId: varchar("zoom_host_user_id"),
    googleCalendarEventId: varchar("google_calendar_event_id"),
    googleCalendarEventUrl: text("google_calendar_event_url"),
    googleCalendarId: varchar("google_calendar_id"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    // Task #4337 — first-touch UTM/referrer attribution captured on the
    // public booking page at confirm time. All nullable; internal/AM-created
    // bookings and pre-feature rows leave them NULL. Raw values as captured —
    // normalization happens at lead-stamp time (shared/models/campaigns.ts).
    utmSource: varchar("utm_source", { length: 200 }),
    utmMedium: varchar("utm_medium", { length: 200 }),
    utmCampaign: varchar("utm_campaign", { length: 200 }),
    utmTerm: varchar("utm_term", { length: 200 }),
    utmContent: varchar("utm_content", { length: 200 }),
    referrer: text("referrer"),
    // Recurrence (Task #1032A — Phase 1). All nullable; one-off bookings
    // continue to leave every column NULL.
    recurrence: text("recurrence").array(),
    recurrenceSource: varchar("recurrence_source"),
    seriesMasterId: varchar("series_master_id").references(
      (): AnyPgColumn => scheduledMeetings.id,
      { onDelete: "set null" },
    ),
    recurringEventId: varchar("recurring_event_id"),
    originalStartTime: timestamp("original_start_time"),
    recurrenceTimezone: varchar("recurrence_timezone"),
    recurrenceSummary: text("recurrence_summary"),
    zoomRecurrenceMode: varchar("zoom_recurrence_mode"),
    zoomRecurrenceFallbackReason: varchar("zoom_recurrence_fallback_reason"),
    previousSeriesMasterId: varchar("previous_series_master_id").references(
      (): AnyPgColumn => scheduledMeetings.id,
      { onDelete: "set null" },
    ),
    nextSeriesMasterId: varchar("next_series_master_id").references(
      (): AnyPgColumn => scheduledMeetings.id,
      { onDelete: "set null" },
    ),
    splitFromMeetingId: varchar("split_from_meeting_id").references(
      (): AnyPgColumn => scheduledMeetings.id,
      { onDelete: "set null" },
    ),
    splitAtOriginalStartTime: timestamp("split_at_original_start_time"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    clientIdx: index("scheduled_meetings_client_idx").on(table.clientId),
    amIdx: index("scheduled_meetings_am_idx").on(table.accountManagerUserId),
    statusIdx: index("scheduled_meetings_status_idx").on(table.status),
    startTimeIdx: index("scheduled_meetings_start_time_idx").on(table.startTimeUtc),
    zoomMeetingIdIdx: index("scheduled_meetings_zoom_meeting_id_idx").on(
      table.zoomMeetingId,
    ),
    zoomMeetingUuidIdx: index("scheduled_meetings_zoom_meeting_uuid_idx").on(
      table.zoomMeetingUuid,
    ),
    googleEventIdx: index("scheduled_meetings_google_event_idx").on(
      table.googleCalendarEventId,
    ),
    idempotencyIdx: uniqueIndex("scheduled_meetings_idempotency_unique_idx")
      .on(table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    amStartIdx: index("scheduled_meetings_am_start_idx").on(
      table.accountManagerUserId,
      table.startTimeUtc,
    ),
    seriesMasterIdx: index("scheduled_meetings_series_master_idx").on(
      table.seriesMasterId,
    ),
    recurringEventIdx: index("scheduled_meetings_recurring_event_idx").on(
      table.recurringEventId,
      table.originalStartTime,
    ),
  }),
);

export const insertScheduledMeetingSchema = createInsertSchema(scheduledMeetings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertScheduledMeeting = z.infer<typeof insertScheduledMeetingSchema>;
export type ScheduledMeeting = typeof scheduledMeetings.$inferSelect;

export const recurrenceExceptionTypes = [
  "canceled",
  "rescheduled",
] as const;
export type RecurrenceExceptionType = (typeof recurrenceExceptionTypes)[number];

export const recurrenceExceptionScopes = [
  "this_event",
  "this_and_following",
  "entire_series",
] as const;
export type RecurrenceExceptionScope =
  (typeof recurrenceExceptionScopes)[number];

export const meetingRecurrenceExceptions = pgTable(
  "meeting_recurrence_exceptions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    scheduledMeetingId: varchar("scheduled_meeting_id").references(
      (): AnyPgColumn => scheduledMeetings.id,
      { onDelete: "set null" },
    ),
    seriesMasterId: varchar("series_master_id")
      .references((): AnyPgColumn => scheduledMeetings.id, {
        onDelete: "cascade",
      })
      .notNull(),
    recurringEventId: varchar("recurring_event_id"),
    originalStartTime: timestamp("original_start_time").notNull(),
    exceptionType: varchar("exception_type").notNull(),
    overrideStartTimeUtc: timestamp("override_start_time_utc"),
    overrideEndTimeUtc: timestamp("override_end_time_utc"),
    overrideTimezone: varchar("override_timezone"),
    reason: text("reason"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    meetingIdx: index("meeting_recurrence_exceptions_meeting_idx").on(
      table.scheduledMeetingId,
    ),
    masterIdx: index("meeting_recurrence_exceptions_master_idx").on(
      table.seriesMasterId,
    ),
    eventIdx: index("meeting_recurrence_exceptions_event_idx").on(
      table.recurringEventId,
      table.originalStartTime,
    ),
    masterStartUnique: unique("meeting_recurrence_exceptions_unique").on(
      table.seriesMasterId,
      table.originalStartTime,
    ),
  }),
);

export const insertMeetingRecurrenceExceptionSchema = createInsertSchema(
  meetingRecurrenceExceptions,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMeetingRecurrenceException = z.infer<
  typeof insertMeetingRecurrenceExceptionSchema
>;
export type MeetingRecurrenceException =
  typeof meetingRecurrenceExceptions.$inferSelect;

/**
 * Raw recurrence payload accepted from the API / UI. Stores the RRULE
 * lines (RRULE/EXDATE/RDATE) plus the IANA timezone they're anchored
 * in. Validated and normalized by `validateRecurrencePayload`.
 */
export const recurrencePayloadSchema = z.object({
  // Caps line count cheaply at the API boundary; the downstream
  // validator enforces the per-category caps (one RRULE, ≤ EXDATE
  // cap, etc.). 200 lines comfortably covers 1 RRULE + 50 EXDATEs +
  // headroom without letting a hostile payload blow up the parser.
  rrule: z
    .array(z.string().min(1))
    .min(1)
    .max(200),
  timezone: z.string().min(1),
  source: z.enum(["app", "google_calendar"]).optional(),
  summary: z.string().max(500).optional(),
});
export type RecurrencePayload = z.infer<typeof recurrencePayloadSchema>;

/**
 * Result of `validateRecurrencePayload`. The expander operates on this
 * shape — RRULE lines are split into a single FREQ/COUNT/UNTIL/BYxxx
 * RRULE plus optional EXDATE/RDATE lists with their concrete instants.
 */
export interface NormalizedRecurrence {
  /** Original RRULE/EXDATE/RDATE lines, normalized (trimmed, prefixed). */
  lines: string[];
  /** The single RRULE line (`RRULE:FREQ=…`). */
  rruleLine: string;
  /** EXDATE instants represented as UTC `Date`s (resolved in the recurrence tz). */
  exdates: Date[];
  /** RDATE instants represented as UTC `Date`s (resolved in the recurrence tz). */
  rdates: Date[];
  /** IANA timezone the rule is anchored in. */
  timezone: string;
  /** Optional source/summary echoed back. */
  source: "app" | "google_calendar";
  summary?: string;
}

export const recurrenceErrorCodes = [
  "recurrence_invalid_rrule",
  "recurrence_invalid_timezone",
  "recurrence_count_until_conflict",
  "recurrence_exdate_timezone_mismatch",
  "recurrence_too_many_exdates",
  "recurrence_horizon_exceeded",
  "recurrence_expansion_limit_exceeded",
] as const;
export type RecurrenceErrorCode = (typeof recurrenceErrorCodes)[number];

export interface RecurrenceConflict {
  originalStartTime: string;
  startUtc: string;
  endUtc: string;
  reason: string;
}

export interface RecurrencePreviewOccurrence {
  originalStartTime: string;
  startUtc: string;
  endUtc: string;
}

export interface RecurrencePreviewResponse {
  occurrences: RecurrencePreviewOccurrence[];
  truncated: boolean;
  conflicts: RecurrenceConflict[];
  summary?: string;
}

/**
 * Zoom recurrence object (for type-8 recurring meetings). Field names and
 * semantics mirror Zoom's `meeting.recurrence` payload exactly:
 *   type: 1=daily, 2=weekly, 3=monthly
 *   repeat_interval: 1..90 (daily) / 1..12 (weekly) / 1..3 (monthly)
 *   weekly_days: comma-separated "1,3,5" where 1=Sunday … 7=Saturday
 *   monthly_day: 1..31 (monthly by day-of-month)
 *   monthly_week: 1|2|3|4|-1 (1=first … -1=last)
 *   monthly_week_day: 1..7 (paired with monthly_week, same encoding as weekly_days)
 *   end_times: total occurrence count (1..50)
 *   end_date_time: ISO-8601 UTC instant (mutually exclusive with end_times)
 */
export interface ZoomRecurrenceObject {
  type: 1 | 2 | 3;
  repeat_interval: number;
  weekly_days?: string;
  monthly_day?: number;
  monthly_week?: 1 | 2 | 3 | 4 | -1;
  monthly_week_day?: number;
  end_times?: number;
  end_date_time?: string;
}

export const zoomRecurrenceFallbackReasons = [
  "yearly_not_supported",
  "exdate_present",
  "rdate_present",
  "complex_bysetpos",
  "weekly_interval_with_multi_day",
  "weekly_interval_too_large",
  "daily_interval_too_large",
  "monthly_interval_too_large",
  "monthly_missing_day_or_position",
  "monthly_byday_unsupported",
  "monthly_bymonthday_multi",
  "monthly_bymonthday_negative",
  "weekly_day_count_too_large",
  "end_times_too_large",
  "unsupported_freq",
  "byhour_byminute_unsupported",
  "byweekno_unsupported",
  "byyearday_unsupported",
  "bymonth_unsupported",
  "wkst_unsupported",
  // Task #1044: surfaced when the
  // `booking_recurring_zoom_recurring_enabled` feature flag is OFF.
  // The translator/wrapper never produces this from RRULE inspection
  // — it's stamped at the wrapper boundary so callers can distinguish
  // "rule wasn't representable" from "Zoom-recurring path was
  // administratively disabled" in logs and observability.
  "feature_flag_disabled",
] as const;
export type ZoomRecurrenceFallbackReason =
  (typeof zoomRecurrenceFallbackReasons)[number];

export type ZoomRecurrenceTranslationResult =
  | { fullyRepresentable: true; zoomRecurrence: ZoomRecurrenceObject }
  | { fullyRepresentable: false; reason: ZoomRecurrenceFallbackReason; message: string };

export const zoomRecurrenceModes = [
  "zoom_recurring",
  "static_link_fallback",
] as const;
export type ZoomRecurrenceMode = (typeof zoomRecurrenceModes)[number];

export const googleCalendarCredentialStatuses = [
  "connected",
  "disconnected",
  "expired",
  "missing_scope",
  "refresh_failed",
] as const;
export type GoogleCalendarCredentialStatus =
  (typeof googleCalendarCredentialStatuses)[number];

export const googleCalendarCredentials = pgTable(
  "google_calendar_credentials",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    googleAccountEmail: varchar("google_account_email"),
    calendarId: varchar("calendar_id").notNull().default("primary"),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiry: timestamp("token_expiry"),
    scopes: text("scopes"),
    status: varchar("status").notNull().default("disconnected"),
    lastRefreshAt: timestamp("last_refresh_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    userIdx: index("google_calendar_creds_user_idx").on(table.userId),
  }),
);

export const insertGoogleCalendarCredentialSchema = createInsertSchema(
  googleCalendarCredentials,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertGoogleCalendarCredential = z.infer<
  typeof insertGoogleCalendarCredentialSchema
>;
export type GoogleCalendarCredential =
  typeof googleCalendarCredentials.$inferSelect;

export const bookingClientTokens = pgTable(
  "booking_client_tokens",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
    clientId: varchar("client_id")
      .references(() => clients.id, { onDelete: "cascade" })
      .notNull(),
    accountManagerUserId: varchar("account_manager_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    bookingPageId: varchar("booking_page_id")
      .references(() => bookingPages.id, { onDelete: "cascade" })
      .notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdByUserId: varchar("created_by_user_id").references(() => users.id),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    clientIdx: index("booking_client_tokens_client_idx").on(table.clientId),
    pageIdx: index("booking_client_tokens_page_idx").on(table.bookingPageId),
    expiresIdx: index("booking_client_tokens_expires_idx").on(table.expiresAt),
  }),
);

export const insertBookingClientTokenSchema = createInsertSchema(
  bookingClientTokens,
).omit({ id: true, createdAt: true, usedAt: true });
export type InsertBookingClientToken = z.infer<
  typeof insertBookingClientTokenSchema
>;
export type BookingClientToken = typeof bookingClientTokens.$inferSelect;

/**
 * Normalize a Zoom meeting id for deterministic lookup. Zoom may format ids as
 * numbers, strings, or with embedded spaces — strip whitespace and reduce to
 * the underlying digit sequence so writes and reads match.
 */
export function normalizeZoomMeetingId(
  raw: string | number | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const str = typeof raw === "number" ? String(raw) : raw;
  const trimmed = String(str).trim();
  if (!trimmed) return null;
  const digitsOnly = trimmed.replace(/\D+/g, "");
  return digitsOnly || null;
}

/**
 * Normalize a Zoom meeting UUID for deterministic lookup. UUIDs are
 * Zoom-specific (base64-style) — preserve case but trim whitespace so a value
 * with surrounding spaces still matches the stored row.
 */
export function normalizeZoomMeetingUuid(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed || null;
}
