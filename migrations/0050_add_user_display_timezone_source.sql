-- Migration 0050: track the source of users.timezone (Task #1033)
--
-- Lets us distinguish a timezone that was explicitly chosen by the user
-- ('user') from one that was seeded from their connected Google Calendar
-- account ('google_calendar') from one that has never been set (NULL).
-- The Google Calendar timezone seeder may overwrite NULL or
-- 'google_calendar' values but never overwrites a 'user' value, so a
-- user's explicit pick always wins.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_timezone_source varchar(32);

-- Backfill: only rows whose timezone differs from the historical
-- America/Chicago column default are treated as explicit user picks
-- (we have no other provenance signal, but a non-default value can
-- only have come from someone choosing it). Rows still carrying the
-- legacy default are intentionally left as NULL provenance so the
-- Google Calendar seeder can replace them with the user's real zone
-- on the next /status load — that's the "already-connected users
-- get backfilled on next load" requirement of Task #1033.
UPDATE users
SET display_timezone_source = 'user'
WHERE display_timezone_source IS NULL
  AND timezone IS NOT NULL
  AND timezone <> 'America/Chicago';

-- Drop the legacy default. New rows now start with NULL timezone and
-- the client-side resolver falls back to the browser zone until the
-- user picks one or connects Google Calendar.
ALTER TABLE users
  ALTER COLUMN timezone DROP DEFAULT;

COMMIT;
