-- ClickUp OAuth: record every workspace the user authorized on ClickUp's
-- consent screen (not just the first). Idempotent.
ALTER TABLE clickup_user_tokens
  ADD COLUMN IF NOT EXISTS authorized_workspaces jsonb;
