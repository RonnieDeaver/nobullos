-- Migration 0071 — Task #1758: User role model split into function + authority.
--
-- Adds two new columns alongside the legacy `users.role`:
--   * functions text[]         — assigned function chips (multi-select)
--   * authority_level varchar  — assigned authority tier
--
-- Also adds the `role_permissions_permissive_mode` switch in
-- `system_settings`. Default is "true" — every authenticated user keeps
-- team-lead-equivalent access regardless of assigned function/authority.
-- Tightening permissions later is a single flip of this switch; route
-- handlers do not need to change.
--
-- `users.role` is PRESERVED as a backward-compat bridge derived from
-- `authority_level` (core → account_manager, lead/director → team_lead,
-- ceo → ceo). Derivation happens at the service layer on every write
-- (see server/storage/clientStorage.ts:updateUserRoleProfile). This
-- migration also backfills `role` for any existing rows so legacy
-- read-side code keeps working.
--
-- Backfill mapping:
--   ceo             → authority_level=ceo,  functions=[revenue_engineer]
--   team_lead       → authority_level=lead, functions=[revenue_engineer]
--   account_manager → authority_level=core, functions=[revenue_engineer]
--   sales           → authority_level=core, functions=[sales_engineer]
-- Fulfillment users (GBP / Ads / Webinar / Reporting) are left for
-- admin to set manually post-migration — there is no signal in the
-- legacy role column that can identify them.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS functions text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS authority_level varchar NOT NULL DEFAULT 'core';

-- Backfill authority_level + functions from the legacy role column.
-- Idempotent: only updates rows that still carry the default profile.
UPDATE users
SET authority_level = 'ceo',
    functions = ARRAY['revenue_engineer']::text[]
WHERE role = 'ceo'
  AND (authority_level = 'core' OR authority_level IS NULL)
  AND (functions IS NULL OR array_length(functions, 1) IS NULL);

UPDATE users
SET authority_level = 'lead',
    functions = ARRAY['revenue_engineer']::text[]
WHERE role = 'team_lead'
  AND (authority_level = 'core' OR authority_level IS NULL)
  AND (functions IS NULL OR array_length(functions, 1) IS NULL);

UPDATE users
SET authority_level = 'core',
    functions = ARRAY['revenue_engineer']::text[]
WHERE role = 'account_manager'
  AND (authority_level = 'core' OR authority_level IS NULL)
  AND (functions IS NULL OR array_length(functions, 1) IS NULL);

UPDATE users
SET authority_level = 'core',
    functions = ARRAY['sales_engineer']::text[]
WHERE role = 'sales'
  AND (authority_level = 'core' OR authority_level IS NULL)
  AND (functions IS NULL OR array_length(functions, 1) IS NULL);

-- Permissive-mode switch. Default ON — permissive mode keeps every
-- authenticated user at team-lead-equivalent access. Flip to "false"
-- to switch the entire app to honor assigned authority/functions.
INSERT INTO system_settings (key, value)
VALUES ('role_permissions_permissive_mode', 'true')
ON CONFLICT (key) DO NOTHING;

-- One-time admin banner flag (Task #1758). Stays "true" until a
-- team-lead/CEO dismisses it from the User Management page.
INSERT INTO system_settings (key, value)
VALUES ('role_backfill_review_banner_dismissed', 'false')
ON CONFLICT (key) DO NOTHING;
