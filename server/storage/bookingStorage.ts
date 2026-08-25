// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  bookingPages,
  bookingAvailabilityRules,
  bookingAvailabilityOverrides,
  bookingMeetingTypes,
  scheduledMeetings,
  meetingRecurrenceExceptions,
  googleCalendarCredentials,
  bookingClientTokens,
  normalizeZoomMeetingId,
  normalizeZoomMeetingUuid,
  type BookingPage,
  type InsertBookingPage,
  type UpdateBookingPage,
  updateBookingPageSchema,
  type UpdateBookingMeetingType,
  updateBookingMeetingTypeSchema,
  type BookingAvailabilityRule,
  type InsertBookingAvailabilityRule,
  type BookingAvailabilityOverride,
  type InsertBookingAvailabilityOverride,
  type BookingMeetingType,
  type InsertBookingMeetingType,
  type ScheduledMeeting,
  type InsertScheduledMeeting,
  type ScheduledMeetingStatus,
  type MeetingRecurrenceException,
  type InsertMeetingRecurrenceException,
  type GoogleCalendarCredential,
  type InsertGoogleCalendarCredential,
  type BookingClientToken,
  type InsertBookingClientToken,
} from "@shared/schema";
import { getDb } from "../db";
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql, desc, asc } from "drizzle-orm";

// ---- booking_pages ----

export async function getBookingPageById(
  id: string,
): Promise<BookingPage | undefined> {
  const [row] = await getDb()
    .select()
    .from(bookingPages)
    .where(eq(bookingPages.id, id));
  return row;
}

export async function getBookingPageBySlug(
  slug: string,
): Promise<BookingPage | undefined> {
  const [row] = await getDb()
    .select()
    .from(bookingPages)
    .where(eq(bookingPages.slug, slug));
  return row;
}

export async function getBookingPageByUserId(
  userId: string,
): Promise<BookingPage | undefined> {
  const [row] = await getDb()
    .select()
    .from(bookingPages)
    .where(eq(bookingPages.accountManagerUserId, userId))
    .orderBy(desc(bookingPages.createdAt))
    .limit(1);
  return row;
}

export async function listBookingPages(filters?: {
  active?: boolean;
}): Promise<BookingPage[]> {
  const conds = [];
  if (filters?.active !== undefined) {
    conds.push(eq(bookingPages.active, filters.active));
  }
  let q = getDb().select().from(bookingPages);
  if (conds.length) q = (q as any).where(and(...conds));
  return q;
}

export async function createBookingPage(
  data: InsertBookingPage,
): Promise<BookingPage> {
  const [row] = await getDb().insert(bookingPages).values(data).returning();
  return row;
}

export async function updateBookingPage(
  id: string,
  data: UpdateBookingPage,
): Promise<BookingPage | undefined> {
  // Task #4380 (F8): runtime parse — ownership (accountManagerUserId) and
  // row identity stay out; unknown keys strip.
  const parsed = updateBookingPageSchema.parse(data);
  const [row] = await getDb()
    .update(bookingPages)
    .set({ ...parsed, updatedAt: new Date() })
    .where(eq(bookingPages.id, id))
    .returning();
  return row;
}

export async function deleteBookingPage(id: string): Promise<void> {
  await getDb().delete(bookingPages).where(eq(bookingPages.id, id));
}

// ---- booking_availability_rules ----

export async function listAvailabilityRules(
  bookingPageId: string,
): Promise<BookingAvailabilityRule[]> {
  return getDb()
    .select()
    .from(bookingAvailabilityRules)
    .where(eq(bookingAvailabilityRules.bookingPageId, bookingPageId))
    .orderBy(bookingAvailabilityRules.dayOfWeek, bookingAvailabilityRules.startTimeLocal);
}

export async function createAvailabilityRule(
  data: InsertBookingAvailabilityRule,
): Promise<BookingAvailabilityRule> {
  const [row] = await getDb()
    .insert(bookingAvailabilityRules)
    .values(data)
    .returning();
  return row;
}

export async function deleteAvailabilityRule(id: string): Promise<void> {
  await getDb()
    .delete(bookingAvailabilityRules)
    .where(eq(bookingAvailabilityRules.id, id));
}

export async function replaceAvailabilityRules(
  bookingPageId: string,
  rules: InsertBookingAvailabilityRule[],
): Promise<BookingAvailabilityRule[]> {
  return getDb().transaction(async (tx) => {
    await tx
      .delete(bookingAvailabilityRules)
      .where(eq(bookingAvailabilityRules.bookingPageId, bookingPageId));
    if (!rules.length) return [];
    return tx
      .insert(bookingAvailabilityRules)
      .values(rules.map((r) => ({ ...r, bookingPageId })))
      .returning();
  });
}

// ---- booking_availability_overrides ----

export async function listAvailabilityOverrides(
  bookingPageId: string,
  fromDateLocal?: string,
  toDateLocal?: string,
): Promise<BookingAvailabilityOverride[]> {
  const conds = [eq(bookingAvailabilityOverrides.bookingPageId, bookingPageId)];
  if (fromDateLocal) {
    conds.push(gte(bookingAvailabilityOverrides.dateLocal, fromDateLocal));
  }
  if (toDateLocal) {
    conds.push(lt(bookingAvailabilityOverrides.dateLocal, toDateLocal));
  }
  return getDb()
    .select()
    .from(bookingAvailabilityOverrides)
    .where(and(...conds))
    .orderBy(bookingAvailabilityOverrides.dateLocal);
}

export async function upsertAvailabilityOverride(
  data: InsertBookingAvailabilityOverride,
): Promise<BookingAvailabilityOverride> {
  const [row] = await getDb()
    .insert(bookingAvailabilityOverrides)
    .values(data)
    .onConflictDoUpdate({
      target: [
        bookingAvailabilityOverrides.bookingPageId,
        bookingAvailabilityOverrides.dateLocal,
      ],
      set: {
        isBlocked: data.isBlocked,
        customStartTimeLocal: data.customStartTimeLocal ?? null,
        customEndTimeLocal: data.customEndTimeLocal ?? null,
        reason: data.reason ?? null,
      },
    })
    .returning();
  return row;
}

export async function getAvailabilityOverride(
  id: string,
): Promise<BookingAvailabilityOverride | undefined> {
  const [row] = await getDb()
    .select()
    .from(bookingAvailabilityOverrides)
    .where(eq(bookingAvailabilityOverrides.id, id))
    .limit(1);
  return row;
}

export async function deleteAvailabilityOverride(id: string): Promise<void> {
  await getDb()
    .delete(bookingAvailabilityOverrides)
    .where(eq(bookingAvailabilityOverrides.id, id));
}

// ---- booking_meeting_types ----

export async function listBookingMeetingTypes(
  accountManagerUserId: string,
): Promise<BookingMeetingType[]> {
  return getDb()
    .select()
    .from(bookingMeetingTypes)
    .where(eq(bookingMeetingTypes.accountManagerUserId, accountManagerUserId))
    .orderBy(asc(bookingMeetingTypes.sortOrder), asc(bookingMeetingTypes.createdAt));
}

export async function getBookingMeetingType(
  id: string,
): Promise<BookingMeetingType | undefined> {
  const [row] = await getDb()
    .select()
    .from(bookingMeetingTypes)
    .where(eq(bookingMeetingTypes.id, id));
  return row;
}

export async function createBookingMeetingType(
  data: InsertBookingMeetingType,
): Promise<BookingMeetingType> {
  const [row] = await getDb()
    .insert(bookingMeetingTypes)
    .values(data)
    .returning();
  return row;
}

export async function updateBookingMeetingType(
  id: string,
  data: UpdateBookingMeetingType,
): Promise<BookingMeetingType | undefined> {
  // Task #4380 (F8): runtime parse — ownership (accountManagerUserId) and
  // row identity stay out; unknown keys strip.
  const parsed = updateBookingMeetingTypeSchema.parse(data);
  const [row] = await getDb()
    .update(bookingMeetingTypes)
    .set({ ...parsed, updatedAt: new Date() })
    .where(eq(bookingMeetingTypes.id, id))
    .returning();
  return row;
}

export async function deleteBookingMeetingType(id: string): Promise<void> {
  await getDb()
    .delete(bookingMeetingTypes)
    .where(eq(bookingMeetingTypes.id, id));
}

// ---- scheduled_meetings ----

export async function getScheduledMeetingById(
  id: string,
): Promise<ScheduledMeeting | undefined> {
  const [row] = await getDb()
    .select()
    .from(scheduledMeetings)
    .where(eq(scheduledMeetings.id, id));
  return row;
}

export async function getScheduledMeetingByIdempotencyKey(
  key: string,
): Promise<ScheduledMeeting | undefined> {
  const [row] = await getDb()
    .select()
    .from(scheduledMeetings)
    .where(eq(scheduledMeetings.idempotencyKey, key));
  return row;
}

export async function createScheduledMeeting(
  data: InsertScheduledMeeting,
): Promise<ScheduledMeeting> {
  const normalized = {
    ...data,
    zoomMeetingId: normalizeZoomMeetingId(data.zoomMeetingId ?? null),
    zoomMeetingUuid: normalizeZoomMeetingUuid(data.zoomMeetingUuid ?? null),
  };
  const [row] = await getDb()
    .insert(scheduledMeetings)
    .values(normalized)
    .returning();
  return row;
}

// Task #4380 (F8): dedicated narrow writer type for the booking-scheduler
// saga. These are the exact server-managed lifecycle columns the internal
// writers set (status transitions, Zoom/Google artifacts, recurrence and
// time fields). A runtime schema parse would silently strip these
// server-managed columns, so the contract is compile-time. No route caller
// forwards a request body here.
export type ScheduledMeetingStoragePatch = Partial<
  Pick<
    InsertScheduledMeeting,
    | "status"
    | "failureReason"
    | "zoomMeetingId"
    | "zoomMeetingUuid"
    | "zoomJoinUrl"
    | "zoomStartUrl"
    | "zoomHostUserId"
    | "googleCalendarEventId"
    | "googleCalendarEventUrl"
    | "googleCalendarId"
    | "nextSeriesMasterId"
    | "recurrence"
    | "recurrenceTimezone"
    | "recurrenceSummary"
    | "recurringEventId"
    | "zoomRecurrenceMode"
    | "zoomRecurrenceFallbackReason"
    | "startTimeUtc"
    | "endTimeUtc"
    | "timezone"
    // Task #4330 — lead lifecycle hook links an anonymous public booking to
    // the lead record it matched/created (server-derived, never from a
    // request body).
    | "clientId"
  >
>;

export async function updateScheduledMeeting(
  id: string,
  data: ScheduledMeetingStoragePatch,
): Promise<ScheduledMeeting | undefined> {
  const updates: Record<string, unknown> = { ...data, updatedAt: new Date() };
  if (Object.prototype.hasOwnProperty.call(data, "zoomMeetingId")) {
    updates.zoomMeetingId = normalizeZoomMeetingId(data.zoomMeetingId ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(data, "zoomMeetingUuid")) {
    updates.zoomMeetingUuid = normalizeZoomMeetingUuid(
      data.zoomMeetingUuid ?? null,
    );
  }
  const [row] = await getDb()
    .update(scheduledMeetings)
    .set(updates)
    .where(eq(scheduledMeetings.id, id))
    .returning();
  return row;
}

export async function listScheduledMeetingsForAm(
  accountManagerUserId: string,
  filters?: { status?: ScheduledMeetingStatus[]; from?: Date; to?: Date },
): Promise<ScheduledMeeting[]> {
  const conds = [
    eq(scheduledMeetings.accountManagerUserId, accountManagerUserId),
  ];
  if (filters?.status?.length) {
    conds.push(inArray(scheduledMeetings.status, filters.status));
  }
  if (filters?.from) {
    conds.push(gte(scheduledMeetings.startTimeUtc, filters.from));
  }
  if (filters?.to) {
    conds.push(lt(scheduledMeetings.startTimeUtc, filters.to));
  }
  return getDb()
    .select()
    .from(scheduledMeetings)
    .where(and(...conds))
    .orderBy(scheduledMeetings.startTimeUtc);
}

/**
 * Cursor-paginated meetings list for the signed-in user (Task #1064).
 *
 * Powers the `My Meetings` console on /profile. Distinct from
 * `listScheduledMeetingsForAm` because it adds:
 *   - cursor pagination keyed on `(startTimeUtc, id)` for stable ordering
 *   - tense-aware ordering (upcoming → ASC by start, past → DESC by start)
 *   - text search across summary / invitee name / invitee email
 *   - returns one extra row to compute `nextCursor` without a COUNT
 */
export interface ListMeetingsCursor {
  startTimeUtc: string; // ISO
  id: string;
}

export interface ListUserMeetingsFilters {
  /** "upcoming" → start ≥ now, ASC. "past" → start < now, DESC. */
  tense: "upcoming" | "past";
  status?: ScheduledMeetingStatus[];
  /** Free-text search on summary, invitee email, or invitee name. */
  search?: string;
  /** Only meetings linked to this client. */
  clientId?: string;
  /** Result limit (1–200, default 25). */
  limit?: number;
  /** Pagination cursor from previous page's `nextCursor`. */
  cursor?: ListMeetingsCursor | null;
  /** Anchor for "now" (testing). Defaults to `new Date()`. */
  now?: Date;
}

export interface ListUserMeetingsPage {
  items: ScheduledMeeting[];
  nextCursor: ListMeetingsCursor | null;
}

export async function listScheduledMeetingsForUser(
  userId: string,
  filters: ListUserMeetingsFilters,
): Promise<ListUserMeetingsPage> {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const now = filters.now ?? new Date();
  const conds: any[] = [eq(scheduledMeetings.accountManagerUserId, userId)];

  if (filters.status?.length) {
    conds.push(inArray(scheduledMeetings.status, filters.status));
  }
  if (filters.clientId) {
    conds.push(eq(scheduledMeetings.clientId, filters.clientId));
  }
  if (filters.tense === "upcoming") {
    conds.push(gte(scheduledMeetings.startTimeUtc, now));
  } else {
    conds.push(lt(scheduledMeetings.startTimeUtc, now));
  }
  if (filters.search && filters.search.trim()) {
    const needle = `%${filters.search.trim().toLowerCase()}%`;
    conds.push(
      or(
        sql`lower(coalesce(${scheduledMeetings.recurrenceSummary}, '')) like ${needle}`,
        sql`lower(coalesce(${scheduledMeetings.meetingTypeName}, '')) like ${needle}`,
        sql`lower(coalesce(${scheduledMeetings.inviteeEmail}, '')) like ${needle}`,
        sql`lower(coalesce(${scheduledMeetings.inviteeName}, '')) like ${needle}`,
      ),
    );
  }
  if (filters.cursor) {
    const cStart = new Date(filters.cursor.startTimeUtc);
    if (filters.tense === "upcoming") {
      conds.push(
        or(
          sql`${scheduledMeetings.startTimeUtc} > ${cStart}`,
          and(
            eq(scheduledMeetings.startTimeUtc, cStart),
            sql`${scheduledMeetings.id} > ${filters.cursor.id}`,
          ),
        ),
      );
    } else {
      conds.push(
        or(
          sql`${scheduledMeetings.startTimeUtc} < ${cStart}`,
          and(
            eq(scheduledMeetings.startTimeUtc, cStart),
            sql`${scheduledMeetings.id} < ${filters.cursor.id}`,
          ),
        ),
      );
    }
  }

  const orderBy =
    filters.tense === "upcoming"
      ? [asc(scheduledMeetings.startTimeUtc), asc(scheduledMeetings.id)]
      : [desc(scheduledMeetings.startTimeUtc), desc(scheduledMeetings.id)];

  // Fetch limit+1 so we can detect a next page without COUNT.
  const rows = await getDb()
    .select()
    .from(scheduledMeetings)
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor: ListMeetingsCursor | null =
    hasMore && items.length > 0
      ? {
          startTimeUtc: items[items.length - 1].startTimeUtc.toISOString(),
          id: items[items.length - 1].id,
        }
      : null;
  return { items, nextCursor };
}

export async function listScheduledMeetingsForClient(
  clientId: string,
): Promise<ScheduledMeeting[]> {
  return getDb()
    .select()
    .from(scheduledMeetings)
    .where(eq(scheduledMeetings.clientId, clientId))
    .orderBy(desc(scheduledMeetings.startTimeUtc));
}

export async function listOverlappingScheduledMeetingsForAm(
  accountManagerUserId: string,
  startUtc: Date,
  endUtc: Date,
): Promise<ScheduledMeeting[]> {
  return getDb()
    .select()
    .from(scheduledMeetings)
    .where(
      and(
        eq(scheduledMeetings.accountManagerUserId, accountManagerUserId),
        inArray(scheduledMeetings.status, ["creating", "confirmed"]),
        lt(scheduledMeetings.startTimeUtc, endUtc),
        sql`${scheduledMeetings.endTimeUtc} > ${startUtc}`,
      ),
    );
}

/**
 * Deterministic recording-match lookup. Tries the meeting id first
 * (number-based) and then the meeting uuid (string-based) — both normalized
 * exactly the same way as on insert.
 */
export async function findScheduledMeetingByZoomIds(
  zoomMeetingId: string | number | null | undefined,
  zoomMeetingUuid: string | null | undefined,
): Promise<ScheduledMeeting | undefined> {
  const normId = normalizeZoomMeetingId(zoomMeetingId ?? null);
  const normUuid = normalizeZoomMeetingUuid(zoomMeetingUuid ?? null);
  if (!normId && !normUuid) return undefined;

  const conds: any[] = [];
  if (normUuid) {
    conds.push(eq(scheduledMeetings.zoomMeetingUuid, normUuid));
  }
  if (normId) {
    conds.push(eq(scheduledMeetings.zoomMeetingId, normId));
  }

  const [row] = await getDb()
    .select()
    .from(scheduledMeetings)
    .where(
      and(
        eq(scheduledMeetings.status, "confirmed"),
        or(...conds),
      ),
    )
    .orderBy(desc(scheduledMeetings.createdAt))
    .limit(1);
  return row;
}

export async function getScheduledMeetingMatchStats(
  sinceDays = 30,
): Promise<{
  totalLast30Days: number;
  byStatus: { status: string; count: number }[];
  bySource: { source: string; count: number }[];
  byMatchMethod: { matchMethod: string | null; count: number }[];
}> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const [statusRows, sourceRows, matchRows] = await Promise.all([
    getDb()
      .select({
        status: scheduledMeetings.status,
        n: sql<number>`count(*)::int`,
      })
      .from(scheduledMeetings)
      .where(gte(scheduledMeetings.createdAt, since))
      .groupBy(scheduledMeetings.status),
    getDb()
      .select({
        source: scheduledMeetings.bookingSource,
        n: sql<number>`count(*)::int`,
      })
      .from(scheduledMeetings)
      .where(gte(scheduledMeetings.createdAt, since))
      .groupBy(scheduledMeetings.bookingSource),
    // Recording match-method breakdown: count Zoom raw records ingested
    // in the window and report how each was attributed to a client. Zoom
    // records use sourceType='zoom' with sourceSubtype distinguishing
    // meeting/recording/transcript. We LEFT JOIN to communication_client_links
    // so records that were NEVER attributed to a client surface as the
    // synthetic `unmatched` bucket — that's exactly what the admin needs
    // in order to spot OS-booked meetings that the deterministic
    // `booked_in_app` path missed and fell through to the fuzzy matchers
    // (or fell off entirely).
    getDb().execute(sql`
      SELECT
        COALESCE(l.match_method, 'unmatched') AS match_method,
        COUNT(*)::int AS n
      FROM raw_communication_records r
      LEFT JOIN communication_client_links l
        ON l.raw_communication_record_id = r.id
      WHERE r.source_type = 'zoom'
        AND r.source_subtype IN ('zoom_meeting', 'zoom_recording', 'zoom_transcript')
        AND r.created_at >= ${since}
      GROUP BY COALESCE(l.match_method, 'unmatched')
    `),
  ]);

  const totalLast30Days = statusRows.reduce((sum, r) => sum + r.n, 0);
  const byStatus = statusRows.map((r) => ({
    status: r.status,
    count: r.n,
  }));
  const bySource = sourceRows.map((r) => ({
    source: r.source,
    count: r.n,
  }));
  const byMatchMethod = (matchRows.rows as Array<{
    match_method: string | null;
    n: number;
  }>).map((r) => ({
    matchMethod: r.match_method,
    count: Number(r.n),
  }));

  return { totalLast30Days, byStatus, bySource, byMatchMethod };
}

// ---- meeting_recurrence_exceptions ----

export async function createMeetingRecurrenceException(
  data: InsertMeetingRecurrenceException,
): Promise<MeetingRecurrenceException> {
  const [row] = await getDb()
    .insert(meetingRecurrenceExceptions)
    .values(data)
    .returning();
  return row;
}

/**
 * Idempotent upsert keyed on the `(seriesMasterId, originalStartTime)` unique
 * index. Re-issuing an edit/cancel for the same occurrence overwrites the
 * previous exception row instead of erroring on the unique violation, which
 * matches the saga's compensation expectations (a retry must converge).
 */
export async function upsertMeetingRecurrenceException(
  data: InsertMeetingRecurrenceException,
): Promise<MeetingRecurrenceException> {
  const [row] = await getDb()
    .insert(meetingRecurrenceExceptions)
    .values(data)
    .onConflictDoUpdate({
      target: [
        meetingRecurrenceExceptions.seriesMasterId,
        meetingRecurrenceExceptions.originalStartTime,
      ],
      set: {
        scheduledMeetingId: data.scheduledMeetingId ?? null,
        recurringEventId: data.recurringEventId ?? null,
        exceptionType: data.exceptionType,
        overrideStartTimeUtc: data.overrideStartTimeUtc ?? null,
        overrideEndTimeUtc: data.overrideEndTimeUtc ?? null,
        overrideTimezone: data.overrideTimezone ?? null,
        reason: data.reason ?? null,
        createdByUserId: data.createdByUserId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function listMeetingRecurrenceExceptionsForMaster(
  seriesMasterId: string,
): Promise<MeetingRecurrenceException[]> {
  return getDb()
    .select()
    .from(meetingRecurrenceExceptions)
    .where(eq(meetingRecurrenceExceptions.seriesMasterId, seriesMasterId))
    .orderBy(meetingRecurrenceExceptions.originalStartTime);
}

export async function getMeetingRecurrenceException(
  seriesMasterId: string,
  originalStartTime: Date,
): Promise<MeetingRecurrenceException | undefined> {
  const [row] = await getDb()
    .select()
    .from(meetingRecurrenceExceptions)
    .where(
      and(
        eq(meetingRecurrenceExceptions.seriesMasterId, seriesMasterId),
        eq(meetingRecurrenceExceptions.originalStartTime, originalStartTime),
      ),
    )
    .limit(1);
  return row;
}

// ---- google_calendar_credentials ----

export async function getGoogleCalendarCredential(
  userId: string,
): Promise<GoogleCalendarCredential | undefined> {
  const [row] = await getDb()
    .select()
    .from(googleCalendarCredentials)
    .where(eq(googleCalendarCredentials.userId, userId));
  return row;
}

export async function listGoogleCalendarCredentials(): Promise<
  GoogleCalendarCredential[]
> {
  return getDb().select().from(googleCalendarCredentials);
}

export async function upsertGoogleCalendarCredential(
  data: InsertGoogleCalendarCredential,
): Promise<GoogleCalendarCredential> {
  const [row] = await getDb()
    .insert(googleCalendarCredentials)
    .values(data)
    .onConflictDoUpdate({
      target: googleCalendarCredentials.userId,
      set: {
        googleAccountEmail: data.googleAccountEmail ?? null,
        calendarId: data.calendarId ?? "primary",
        accessTokenEncrypted: data.accessTokenEncrypted ?? null,
        refreshTokenEncrypted: data.refreshTokenEncrypted ?? null,
        tokenExpiry: data.tokenExpiry ?? null,
        scopes: data.scopes ?? null,
        status: data.status ?? "disconnected",
        lastRefreshAt: data.lastRefreshAt ?? null,
        lastError: data.lastError ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

// Task #4380 (F8): dedicated narrow writer type — token-refresh and
// connect flows legitimately rewrite encrypted token material and status,
// but row identity/ownership (userId) stays in the WHERE clause only.
export type GoogleCalendarCredentialStoragePatch = Partial<
  Pick<
    InsertGoogleCalendarCredential,
    | "calendarId"
    | "accessTokenEncrypted"
    | "refreshTokenEncrypted"
    | "tokenExpiry"
    | "lastRefreshAt"
    | "lastError"
    | "status"
  >
>;

export async function updateGoogleCalendarCredential(
  userId: string,
  data: GoogleCalendarCredentialStoragePatch,
): Promise<GoogleCalendarCredential | undefined> {
  const [row] = await getDb()
    .update(googleCalendarCredentials)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(googleCalendarCredentials.userId, userId))
    .returning();
  return row;
}

export async function deleteGoogleCalendarCredential(
  userId: string,
): Promise<void> {
  await getDb()
    .delete(googleCalendarCredentials)
    .where(eq(googleCalendarCredentials.userId, userId));
}

// ---- booking_client_tokens ----

export async function createBookingClientToken(
  data: InsertBookingClientToken,
): Promise<BookingClientToken> {
  const [row] = await getDb()
    .insert(bookingClientTokens)
    .values(data)
    .returning();
  return row;
}

export async function findBookingClientTokenByHash(
  tokenHash: string,
): Promise<BookingClientToken | undefined> {
  const [row] = await getDb()
    .select()
    .from(bookingClientTokens)
    .where(eq(bookingClientTokens.tokenHash, tokenHash));
  return row;
}

export async function markBookingClientTokenUsed(
  id: string,
): Promise<BookingClientToken | undefined> {
  // Atomic "burn" — only flips usedAt if it's still NULL. Returns
  // undefined if the row was already used by a concurrent request, which
  // the caller can treat as a 409 instead of a silent overwrite.
  const [row] = await getDb()
    .update(bookingClientTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(bookingClientTokens.id, id),
        isNull(bookingClientTokens.usedAt),
      ),
    )
    .returning();
  return row;
}

export async function listBookingClientTokensForClient(
  clientId: string,
): Promise<BookingClientToken[]> {
  return getDb()
    .select()
    .from(bookingClientTokens)
    .where(eq(bookingClientTokens.clientId, clientId))
    .orderBy(desc(bookingClientTokens.createdAt));
}
