-- Task #4377 — app-wide dark mode capstone.
-- Per-user theme preference: 'light' | 'dark' | 'system'. Default 'system'
-- so existing rows follow the OS preference (today's behavior for most
-- users = light). Idempotent for the replay seam.
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference varchar DEFAULT 'system';
