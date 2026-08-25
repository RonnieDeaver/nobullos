-- Task #3546: add client_subgroup_collapsed to comms_sidebar_categories
-- Persists whether the client-channels sub-group within the built-in
-- "Channels" category is collapsed (true) or expanded (false).
-- Defaults to true (collapsed) matching the UX default.
ALTER TABLE comms_sidebar_categories
  ADD COLUMN IF NOT EXISTS client_subgroup_collapsed boolean NOT NULL DEFAULT true;
