-- Task 600: Track Slack/email alert delivery status on admin_setting_audit rows
-- so the Common First Names history table can show the same delivery badges
-- (delivered / skipped / failed) that the threshold history already exposes.
ALTER TABLE "admin_setting_audit"
  ADD COLUMN IF NOT EXISTS "slack_status" varchar,
  ADD COLUMN IF NOT EXISTS "email_status" varchar,
  ADD COLUMN IF NOT EXISTS "slack_failure_reason" text,
  ADD COLUMN IF NOT EXISTS "email_failure_reason" text;
