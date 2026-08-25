-- Task #1866 — Soft-delete + revocation for User Management.
--
-- `deleted_at` is the durable revocation signal. When set, the user:
--   * disappears from `getAllUsers()` / `getUser()` (so they stop
--     appearing in admin lists, assignment pickers, role checks, etc.)
--   * is rejected by the Replit OIDC `verify` callback at login time
--     (the upsert path checks revocation BEFORE re-creating the row)
--   * has every session for their `users.id` purged from the PG-backed
--     session store so any live session 401s on its next request.
--
-- We keep the row instead of deleting it because the schema has many
-- FK references to `users.id` (created_by, assigned_to, audit columns,
-- etc.). Hard-deleting would either require cascade everywhere (losing
-- audit history) or be blocked by FKs. Soft-delete preserves the audit
-- trail while making the user functionally gone from the app.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at timestamp;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at);
