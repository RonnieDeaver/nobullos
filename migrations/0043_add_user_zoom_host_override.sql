-- Migration 0043: per-user Zoom host override (Task #931 / 929B).
--
-- Adds explicit override columns so an AM whose app-login email does
-- not match their Zoom account email can persist a validated Zoom
-- mapping. The canonical effective-host resolver introduced in 929C
-- reads these columns; when both override columns are NULL the
-- existing auto-resolve fallback (lookup by `users.email`) applies.
--
-- All columns are nullable so existing users continue to use the
-- auto-resolve path until they explicitly opt in.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS zoom_host_override_email varchar,
  ADD COLUMN IF NOT EXISTS zoom_host_override_user_id varchar,
  ADD COLUMN IF NOT EXISTS zoom_host_override_validated_at timestamp,
  ADD COLUMN IF NOT EXISTS zoom_host_override_validated_email varchar,
  ADD COLUMN IF NOT EXISTS zoom_host_override_display_name varchar;
