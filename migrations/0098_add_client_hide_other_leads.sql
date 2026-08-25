-- Migration 0098 — per-client "hide Other leads on reports" toggle (Task #2667).
--
-- Adds a team-controlled, per-client setting that, when true, suppresses the
-- "Other" lead bucket (social / direct call / referral / residual /
-- inactive-product leads) from the client's public report: total leads, the
-- lead-source pie + legend + percentages, lead-quality denominators, the
-- "Other sources: …" line, and every figure derived from total leads
-- (including the Marketing trend chart's Total series). Default false → reports
-- render byte-for-byte unchanged. The underlying "Other" data is still imported
-- and stored; this only suppresses it from the rendered report. Per-client only
-- (not per-report or global), with no client-facing control.
--
-- Additive boolean column with a non-null default — publish-safe (existing rows
-- default to false = "show Other", the historical behaviour; no backfill
-- required, no constraint to violate).
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS hide_other_leads boolean DEFAULT false;
