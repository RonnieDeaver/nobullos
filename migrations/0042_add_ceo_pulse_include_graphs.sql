-- Migration 0042: CEO Pulse "Include graphs" toggle.
--
-- Adds a per-pulse boolean that controls whether chart extraction,
-- chart-image generation, and graph rendering happen for that pulse.
-- Default true preserves existing behavior for legacy rows.
ALTER TABLE ceo_pulses
  ADD COLUMN IF NOT EXISTS include_graphs boolean NOT NULL DEFAULT true;
