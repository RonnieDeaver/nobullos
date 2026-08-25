-- Task 491: Show alert delivery status next to each threshold change in history.
-- Track per-row Slack/email alert delivery outcomes so admins can tell whether
-- an external notification went out for each threshold change.
ALTER TABLE "agent_match_setting_history"
  ADD COLUMN IF NOT EXISTS "slack_status" varchar,
  ADD COLUMN IF NOT EXISTS "email_status" varchar;
