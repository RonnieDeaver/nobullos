-- Task #1927 — Re-attributed message drill-down.
--
-- When the SuggestRulesDialog "Apply now" sweep re-attributes a
-- previously-dismissed front_sync_emails row to a freshly created rule,
-- the original operational_classification_reason is overwritten in
-- place. We need to keep a copy of what the prior reason was so admins
-- can spot-check what their new rule actually grabbed and decide
-- whether to undo it before more hits accumulate.
--
-- Nullable: hits recorded by the live classifier (no prior reason)
-- and any legacy rows leave this empty.
ALTER TABLE front_operational_rule_hits
  ADD COLUMN IF NOT EXISTS prev_reason text;
