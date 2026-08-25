-- Task 416: Zoom matching 412D — add review_required attribution metadata to agent_match_decisions
ALTER TABLE "agent_match_decisions"
  ADD COLUMN IF NOT EXISTS "source_type" varchar,
  ADD COLUMN IF NOT EXISTS "candidate_shortlist_json" jsonb,
  ADD COLUMN IF NOT EXISTS "prior_client_id" varchar,
  ADD COLUMN IF NOT EXISTS "review_reason" varchar,
  ADD COLUMN IF NOT EXISTS "review_resolution" varchar,
  ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" varchar;

CREATE INDEX IF NOT EXISTS "agent_match_decisions_source_type_status_idx"
  ON "agent_match_decisions" ("source_type", "status");

CREATE INDEX IF NOT EXISTS "agent_match_decisions_review_resolution_idx"
  ON "agent_match_decisions" ("review_resolution");
