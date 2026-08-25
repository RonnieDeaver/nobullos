-- Task 522: Structured dismiss reasons for Zoom review queue.
-- Persist dismiss reason on agent_match_decisions so the audit trail does
-- not depend on the raw_communication_records.matchMethod string.
ALTER TABLE "agent_match_decisions"
  ADD COLUMN IF NOT EXISTS "dismiss_reason" varchar,
  ADD COLUMN IF NOT EXISTS "dismiss_reason_note" text;
