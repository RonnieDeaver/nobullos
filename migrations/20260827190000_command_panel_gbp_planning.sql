-- Add durable onboarding planning fields to the existing per-client Command Panel.
ALTER TABLE command_panels
  ADD COLUMN IF NOT EXISTS gbp_planned_location_count integer,
  ADD COLUMN IF NOT EXISTS gbp_planned_location_cities text[];