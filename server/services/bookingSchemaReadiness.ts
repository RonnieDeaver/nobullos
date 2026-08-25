import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Snapshot of which booking-related schema objects are present in the
 * database. Updated by `ensureBookingTables` at boot and by
 * `recheckBookingSchemaReadiness` on demand. The booking routes consult
 * this to translate a missing-table 500 into an actionable
 * `booking_schema_not_ready` 503 — see Task #860.
 */
export interface BookingSchemaReadiness {
  tables: {
    bookingPages: boolean;
    bookingAvailabilityRules: boolean;
    bookingAvailabilityOverrides: boolean;
    scheduledMeetings: boolean;
    googleCalendarCredentials: boolean;
    bookingClientTokens: boolean;
  };
  constraints: {
    bookingPagesAccountManagerUnique: boolean;
    scheduledMeetingsNoOverlap: boolean;
  };
  ready: boolean;
  lastCheckedAt: string | null;
  lastError?: string;
}

const REQUIRED_TABLES = [
  "booking_pages",
  "booking_availability_rules",
  "booking_availability_overrides",
  "scheduled_meetings",
  "google_calendar_credentials",
  "booking_client_tokens",
] as const;

type RequiredTable = (typeof REQUIRED_TABLES)[number];

let cached: BookingSchemaReadiness = {
  tables: {
    bookingPages: false,
    bookingAvailabilityRules: false,
    bookingAvailabilityOverrides: false,
    scheduledMeetings: false,
    googleCalendarCredentials: false,
    bookingClientTokens: false,
  },
  constraints: {
    bookingPagesAccountManagerUnique: false,
    scheduledMeetingsNoOverlap: false,
  },
  ready: false,
  lastCheckedAt: null,
};

/**
 * Idempotent SQL that mirrors `migrations/0034_add_booking_tables.sql`.
 * Inlined here so a production restart can self-heal an environment
 * whose migration runner never applied 0034 — without this, the booking
 * endpoints throw `relation "booking_pages" does not exist` on every
 * Schedule-tab load. Safe to run on every boot: every statement is
 * `IF NOT EXISTS`.
 */
const BOOKING_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS booking_pages (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  account_manager_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug varchar(64) NOT NULL UNIQUE,
  timezone varchar NOT NULL DEFAULT 'America/Chicago',
  duration_minutes integer NOT NULL DEFAULT 30,
  buffer_before_minutes integer NOT NULL DEFAULT 0,
  buffer_after_minutes integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  title text,
  description text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_pages_am_idx ON booking_pages (account_manager_user_id);
CREATE INDEX IF NOT EXISTS booking_pages_slug_idx ON booking_pages (slug);

CREATE TABLE IF NOT EXISTS booking_availability_rules (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_page_id varchar NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
  day_of_week integer NOT NULL,
  start_time_local varchar(5) NOT NULL,
  end_time_local varchar(5) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_avail_rules_page_idx ON booking_availability_rules (booking_page_id);
CREATE INDEX IF NOT EXISTS booking_avail_rules_page_day_idx ON booking_availability_rules (booking_page_id, day_of_week);

CREATE TABLE IF NOT EXISTS booking_availability_overrides (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_page_id varchar NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
  date_local date NOT NULL,
  is_blocked boolean NOT NULL DEFAULT false,
  custom_start_time_local varchar(5),
  custom_end_time_local varchar(5),
  reason text,
  created_at timestamp DEFAULT now(),
  CONSTRAINT booking_avail_overrides_page_date_unique UNIQUE (booking_page_id, date_local)
);
CREATE INDEX IF NOT EXISTS booking_avail_overrides_page_idx ON booking_availability_overrides (booking_page_id);

CREATE TABLE IF NOT EXISTS scheduled_meetings (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
  account_manager_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
  booking_page_id varchar REFERENCES booking_pages(id) ON DELETE SET NULL,
  booking_source varchar NOT NULL,
  invitee_name text,
  invitee_email text,
  start_time_utc timestamp NOT NULL,
  end_time_utc timestamp NOT NULL,
  timezone varchar NOT NULL,
  status varchar NOT NULL DEFAULT 'creating',
  failure_reason text,
  zoom_meeting_id varchar,
  zoom_meeting_uuid varchar,
  zoom_join_url text,
  zoom_start_url text,
  zoom_host_user_id varchar,
  google_calendar_event_id varchar,
  google_calendar_event_url text,
  google_calendar_id varchar,
  idempotency_key varchar(128),
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_meetings_client_idx ON scheduled_meetings (client_id);
CREATE INDEX IF NOT EXISTS scheduled_meetings_am_idx ON scheduled_meetings (account_manager_user_id);
CREATE INDEX IF NOT EXISTS scheduled_meetings_status_idx ON scheduled_meetings (status);
CREATE INDEX IF NOT EXISTS scheduled_meetings_start_time_idx ON scheduled_meetings (start_time_utc);
CREATE INDEX IF NOT EXISTS scheduled_meetings_zoom_meeting_id_idx ON scheduled_meetings (zoom_meeting_id);
CREATE INDEX IF NOT EXISTS scheduled_meetings_zoom_meeting_uuid_idx ON scheduled_meetings (zoom_meeting_uuid);
CREATE INDEX IF NOT EXISTS scheduled_meetings_google_event_idx ON scheduled_meetings (google_calendar_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_meetings_idempotency_unique_idx ON scheduled_meetings (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS scheduled_meetings_am_start_idx ON scheduled_meetings (account_manager_user_id, start_time_utc);

CREATE TABLE IF NOT EXISTS google_calendar_credentials (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  google_account_email varchar,
  calendar_id varchar NOT NULL DEFAULT 'primary',
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expiry timestamp,
  scopes text,
  status varchar NOT NULL DEFAULT 'disconnected',
  last_refresh_at timestamp,
  last_error text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS google_calendar_creds_user_idx ON google_calendar_credentials (user_id);

CREATE TABLE IF NOT EXISTS booking_client_tokens (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash varchar(128) NOT NULL UNIQUE,
  client_id varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  account_manager_user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_page_id varchar NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
  expires_at timestamp NOT NULL,
  created_by_user_id varchar REFERENCES users(id),
  used_at timestamp,
  created_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_client_tokens_client_idx ON booking_client_tokens (client_id);
CREATE INDEX IF NOT EXISTS booking_client_tokens_page_idx ON booking_client_tokens (booking_page_id);
CREATE INDEX IF NOT EXISTS booking_client_tokens_expires_idx ON booking_client_tokens (expires_at);
`;

async function probeReadiness(): Promise<BookingSchemaReadiness> {
  const next: BookingSchemaReadiness = {
    tables: { ...cached.tables },
    constraints: { ...cached.constraints },
    ready: false,
    lastCheckedAt: new Date().toISOString(),
  };

  try {
    const tableResult: any = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY(ARRAY[
          'booking_pages',
          'booking_availability_rules',
          'booking_availability_overrides',
          'scheduled_meetings',
          'google_calendar_credentials',
          'booking_client_tokens'
        ]::text[])
    `);
    const tableRows: Array<{ table_name: string }> = Array.isArray(tableResult)
      ? tableResult
      : (tableResult as any).rows ?? [];
    const present = new Set<RequiredTable>(
      tableRows.map((r) => r.table_name as RequiredTable),
    );
    next.tables = {
      bookingPages: present.has("booking_pages"),
      bookingAvailabilityRules: present.has("booking_availability_rules"),
      bookingAvailabilityOverrides: present.has("booking_availability_overrides"),
      scheduledMeetings: present.has("scheduled_meetings"),
      googleCalendarCredentials: present.has("google_calendar_credentials"),
      bookingClientTokens: present.has("booking_client_tokens"),
    };

    const constraintResult: any = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'booking_pages_account_manager_user_id_unique',
        'scheduled_meetings_no_overlap'
      )
    `);
    const constraintRows: Array<{ conname: string }> = Array.isArray(constraintResult)
      ? constraintResult
      : (constraintResult as any).rows ?? [];
    const constraintNames = new Set(constraintRows.map((r) => r.conname));
    next.constraints = {
      bookingPagesAccountManagerUnique: constraintNames.has(
        "booking_pages_account_manager_user_id_unique",
      ),
      scheduledMeetingsNoOverlap: constraintNames.has("scheduled_meetings_no_overlap"),
    };
  } catch (err: any) {
    next.lastError = err?.message || String(err);
    return next;
  }

  next.ready =
    next.tables.bookingPages &&
    next.tables.bookingAvailabilityRules &&
    next.tables.bookingAvailabilityOverrides &&
    next.tables.scheduledMeetings &&
    next.tables.googleCalendarCredentials &&
    next.tables.bookingClientTokens;

  return next;
}

/**
 * Idempotent boot step that creates any missing booking tables (the
 * 0034 schema). Production environments where the migration runner
 * never applied 0034 self-heal on the next restart, eliminating the
 * `relation "booking_pages" does not exist` 500 the Schedule tab was
 * hitting (Task #860).
 *
 * Returns the post-create readiness snapshot. Constraints from 0035 /
 * 0036 are installed by `ensureBookingDbConstraints` immediately after
 * this runs.
 */
export async function ensureBookingTables(): Promise<BookingSchemaReadiness> {
  const before = await probeReadiness();
  const allTablesPresent =
    before.tables.bookingPages &&
    before.tables.bookingAvailabilityRules &&
    before.tables.bookingAvailabilityOverrides &&
    before.tables.scheduledMeetings &&
    before.tables.googleCalendarCredentials &&
    before.tables.bookingClientTokens;

  if (allTablesPresent) {
    cached = before;
    return before;
  }

  const missing = REQUIRED_TABLES.filter(
    (t) => !Object.values(before.tables).some((v) => v) || !tablePresent(before, t),
  );
  console.warn(
    "[Booking] Missing booking tables detected, creating idempotently: " +
      missing.join(", "),
  );

  try {
    await db.execute(sql.raw(BOOKING_TABLES_DDL));
    console.log("[Booking] Booking tables ensured (0034 DDL applied idempotently)");
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(
      "[Booking] CRITICAL — failed to create booking tables; Schedule tab will return 503 booking_schema_not_ready until resolved: " +
        msg,
    );
    const after = await probeReadiness();
    after.lastError = msg;
    cached = after;
    return after;
  }

  const after = await probeReadiness();
  cached = after;
  return after;
}

function tablePresent(snap: BookingSchemaReadiness, table: RequiredTable): boolean {
  switch (table) {
    case "booking_pages":
      return snap.tables.bookingPages;
    case "booking_availability_rules":
      return snap.tables.bookingAvailabilityRules;
    case "booking_availability_overrides":
      return snap.tables.bookingAvailabilityOverrides;
    case "scheduled_meetings":
      return snap.tables.scheduledMeetings;
    case "google_calendar_credentials":
      return snap.tables.googleCalendarCredentials;
    case "booking_client_tokens":
      return snap.tables.bookingClientTokens;
  }
}

/** Returns the cached readiness snapshot without re-querying the DB. */
export function getBookingSchemaReadiness(): BookingSchemaReadiness {
  return cached;
}

/**
 * Test-only seam: overwrite the cached readiness snapshot without touching
 * the database, so route tests can clear (or trip) the schema-readiness
 * gate deterministically. Accepts a partial patch that is shallow-merged
 * onto the current snapshot (with `tables`/`constraints` merged one level
 * deeper). Returns a restore function that reverts to the prior snapshot.
 *
 * Throws unless `NODE_ENV === "test"` so it can never be reached in
 * production code paths.
 */
export function __setBookingSchemaReadinessForTest(
  patch: Partial<BookingSchemaReadiness>,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__setBookingSchemaReadinessForTest is only available when NODE_ENV === 'test'",
    );
  }
  const previous = cached;
  cached = {
    ...previous,
    ...patch,
    tables: { ...previous.tables, ...(patch.tables ?? {}) },
    constraints: { ...previous.constraints, ...(patch.constraints ?? {}) },
  };
  return () => {
    cached = previous;
  };
}

/**
 * Re-probe the database and refresh the cached readiness snapshot. Call
 * after `ensureBookingDbConstraints` so the cache reflects the
 * post-bootstrap state of constraints too.
 */
export async function recheckBookingSchemaReadiness(): Promise<BookingSchemaReadiness> {
  const next = await probeReadiness();
  cached = next;
  return next;
}

/**
 * Detects the Postgres "relation does not exist" error that booking
 * endpoints raise when their backing table is missing. Used to translate
 * those 500s into actionable 503 `booking_schema_not_ready` responses.
 */
export function isMissingBookingRelationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message || "";
  if (!/relation\s+"?(booking_|scheduled_meetings|google_calendar_credentials)/i.test(msg)) {
    return false;
  }
  return /does not exist/i.test(msg);
}
