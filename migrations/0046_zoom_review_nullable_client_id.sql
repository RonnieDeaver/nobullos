-- Migration 0046 — Task #995: Allow no-candidate Zoom review rows.
--
-- Lets MeetingApply, TranscriptApply, and the Zoom Reprocess paths
-- enqueue a `review_required` row in `agent_match_decisions` even when
-- there is no demoted candidate to suggest. Operators triage these
-- "no candidate" items from the Review Queue by picking a client.
--
-- Also adds a partial unique index so concurrent ingestion paths can
-- never create duplicate no-candidate review rows for the same Zoom
-- recording (the existing dedupe lookup keys off
-- (communication_id, client_id) which collapses to a single row when
-- client_id IS NOT NULL but cannot rely on the IS NULL case alone).

ALTER TABLE "agent_match_decisions"
  ALTER COLUMN "client_id" DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  "agent_match_decisions_no_candidate_review_unique"
  ON "agent_match_decisions" ("communication_id")
  WHERE "client_id" IS NULL AND "status" = 'review_required';
