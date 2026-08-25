-- Migration 0096 — per-client monthly review target (Task #2596).
--
-- Task #2579 added a monthly review target that drives the green/yellow/red
-- velocity band on the client-facing Review Generation panel, but it was stored
-- per-report (report_sections.data.reviewGeneration.monthlyTarget), so admins
-- had to re-enter it every month and historical reports never reflected a goal
-- set later. This promotes it to a true per-client setting: entered once on the
-- client record, it applies to every month. The per-report value still wins when
-- present, so existing per-report targets keep working unchanged.
--
-- Additive nullable column — publish-safe (no constraint to violate, no backfill
-- required; existing rows default to NULL = "no client-level target", which the
-- velocity band treats as neutral, never a silent green/red).
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS monthly_review_target integer;
