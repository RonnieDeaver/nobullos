-- Migration 0053 — Per-page "allow recurring" flag (Task #1032E).
--
-- Phase 5 of the recurring-meetings epic. Adds a boolean toggle on the
-- AM's booking page so public bookers can only request recurring
-- meetings when the AM has explicitly opted in. Internal (staff)
-- recurrence is NOT gated by this column — only the public surface.
--
-- Defaults to FALSE so the rollout is a no-op for every existing page.

BEGIN;

ALTER TABLE booking_pages
  ADD COLUMN IF NOT EXISTS allow_recurring boolean NOT NULL DEFAULT false;

COMMIT;
