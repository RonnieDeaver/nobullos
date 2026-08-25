-- Task #4545 — atomic dedupe for SYSTEM-filed feedback items (nightly sweep +
-- post-merge canary "fix main" alerts). Their streak dedupe contract is "at
-- most one OPEN row per (submitter, current_page)". The previous
-- SELECT-then-INSERT could race across concurrent workspaces sharing the dev
-- DB and create duplicates; this partial unique index makes the insert
-- conflict-safe (regressionSweepFeedback.insertSweepItem now uses
-- ON CONFLICT DO NOTHING). Human-submitted rows (user_id not like 'system:%')
-- are unconstrained.
--
-- Idempotent: the UPDATE collapses any historical pending duplicates first
-- (keeping the oldest row per key) so index creation cannot fail, and both
-- statements are no-ops on replay.

UPDATE user_feedback
SET status = 'resolved',
    feedback_text = feedback_text || e'\n\n[Auto-resolved] Duplicate of an earlier open item for the same test (collapsed by the dedupe-index backfill, Task #4545).'
WHERE user_id LIKE 'system:%'
  AND status = 'pending'
  AND current_page IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM user_feedback
    WHERE user_id LIKE 'system:%'
      AND status = 'pending'
      AND current_page IS NOT NULL
    GROUP BY user_id, current_page
  );

CREATE UNIQUE INDEX IF NOT EXISTS user_feedback_system_pending_dedupe_idx
  ON user_feedback (user_id, current_page)
  WHERE status = 'pending' AND user_id LIKE 'system:%' AND current_page IS NOT NULL;
