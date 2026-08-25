-- Idempotent creation of booking tool tables (Task #840).
-- Pre-creates the tables so `drizzle-kit push` does not prompt
-- "is booking_pages created or renamed from user_feedback?".

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
