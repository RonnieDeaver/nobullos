-- Task #3713: intel notes publish directly — retire the "draft" status on
-- intelligence_feed_entries.
--
-- The draft step was pure ceremony: no server logic ever gated on approval
-- (the AI client-context builder reads entries regardless of status, and
-- AI-suggestion promotion already creates entries as "approved"). The create/
-- edit dialog no longer offers a status choice, so notes are published
-- ("approved" — the stored value is unchanged; UI copy says "Published") the
-- moment they are created.
--
-- 1) Flip any rows still sitting in "draft" to "approved" so no notes are
--    stranded in a state the UI can no longer create or filter to.
-- 2) Move the column default from 'draft' to 'approved' to match
--    shared/models/commandCenter.ts.
--
-- Idempotent: the UPDATE matches zero rows on re-run, and SET DEFAULT is
-- absolute. updated_at is deliberately left untouched — this is a vocabulary
-- migration, not an edit.

UPDATE intelligence_feed_entries
SET status = 'approved'
WHERE status = 'draft';

ALTER TABLE intelligence_feed_entries
ALTER COLUMN status SET DEFAULT 'approved';
