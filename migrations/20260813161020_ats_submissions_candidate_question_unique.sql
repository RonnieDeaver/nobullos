-- Task #4705 — atomic dedupe for candidate portal per-answer submits.
-- POST /api/ats/portal/:token/submit was SELECT-then-INSERT: two concurrent
-- duplicates (a timeout retry racing the original) could both see "no existing
-- row" and INSERT two ats_submissions for the same candidate+question, which
-- would double-count in auto-scoring inputs. This unique index makes the write
-- conflict-safe (the route now upserts via ON CONFLICT DO UPDATE), per the
-- repo's SELECT-then-INSERT dup-storm convention (same shape as the Task #4545
-- user_feedback dedupe index).
--
-- Idempotent: the DELETE collapses any historical duplicates first (keeping
-- the newest row per key — the latest answer, matching the update-path
-- semantics) so index creation cannot fail, and both statements are no-ops on
-- replay. Dev/prod were verified duplicate-free at authoring time (2026-08-13).
-- destructive-approved: deletes only strictly-duplicate ats_submissions rows
-- (same candidate_id + question_id), keeping the newest answer per key.

DELETE FROM ats_submissions s
USING ats_submissions keep
WHERE keep.candidate_id = s.candidate_id
  AND keep.question_id = s.question_id
  AND (COALESCE(keep.created_at, 'epoch'::timestamp), keep.id)
      > (COALESCE(s.created_at, 'epoch'::timestamp), s.id);

CREATE UNIQUE INDEX IF NOT EXISTS ats_submissions_candidate_question_unique_idx
  ON ats_submissions (candidate_id, question_id);
