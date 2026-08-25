-- Task #1837 — unify Front Analytics monthly coverage numerator + denominator
-- on "conversations, all directions".
--
-- `numerator_unit` records the unit of `fetched_into_nobull` /
--   `applied_into_nobull`. New writes always persist `"conversations_all"`.
--
-- `analytics_messages_inbound` is a secondary diagnostic — the inbound-
--   messages count Front Analytics Reports returns for the month. The
--   primary `front_total_messages` column now holds the Conversations
--   Search "conversations, all directions" count so it is units-
--   comparable with the numerator.
--
-- Both columns are nullable; legacy rows without explicit values are
-- treated as "not yet recomputed" and the admin UI badges them when
-- units don't match.

ALTER TABLE front_analytics_monthly_coverage
  ADD COLUMN IF NOT EXISTS numerator_unit varchar(32);

ALTER TABLE front_analytics_monthly_coverage
  ADD COLUMN IF NOT EXISTS analytics_messages_inbound integer;
