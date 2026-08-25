-- Task #1044 (#1032I): seed the five recurring-meeting kill-switch
-- rows in `system_settings` so operators can find and flip them
-- without having to remember the canonical names. Defaults are 'true'
-- (the runtime loader at `server/services/bookingFeatureFlags.ts`
-- also defaults missing rows to true so behavior is unchanged when
-- the rows are absent).

INSERT INTO system_settings (key, value)
VALUES
  ('booking_recurring_enabled', 'true'),
  ('booking_recurring_internal_enabled', 'true'),
  ('booking_recurring_public_enabled', 'true'),
  ('booking_recurring_zoom_recurring_enabled', 'true'),
  ('booking_recurring_edit_scopes_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
