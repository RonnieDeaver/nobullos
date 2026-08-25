-- Migration 0036 — Schema-level guarantee that no two ACTIVE
-- (creating | confirmed) scheduled meetings for the same account
-- manager can ever overlap. Previously this was installed only at
-- runtime by `ensureBookingDbConstraints`, which left environments
-- where the bootstrap doesn't run (ad-hoc DB restores, tools that
-- bypass server boot, recovered standbys) without the schema-level
-- guard. Per the task spec, the deterministic no-double-booking
-- invariant must hold at the database level.
--
-- This migration is idempotent — it no-ops if the extension is
-- already present and the constraint is already installed. It is
-- the canonical declaration; the runtime bootstrap remains as a
-- backstop for environments whose migration runner is lagging.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scheduled_meetings_no_overlap'
  ) THEN
    -- Note: start_time_utc / end_time_utc are stored as
    -- "timestamp WITHOUT time zone" (the value is already UTC). We
    -- use tsrange (not tstzrange) here because tstzrange on naive
    -- timestamps depends on the session TIME ZONE setting and is
    -- therefore non-IMMUTABLE — Postgres rejects it inside an
    -- index expression. The `[)` interval semantics make a meeting
    -- that *ends* exactly when the next one starts non-overlapping,
    -- matching the booking saga's logic.
    ALTER TABLE scheduled_meetings
    ADD CONSTRAINT scheduled_meetings_no_overlap
    EXCLUDE USING gist (
      account_manager_user_id WITH =,
      tsrange(start_time_utc, end_time_utc) WITH &&
    )
    WHERE (status IN ('creating', 'confirmed'));
  END IF;
END$$;
