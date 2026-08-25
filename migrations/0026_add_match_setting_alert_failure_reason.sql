-- Task 568: Capture a short failure reason next to failed threshold alerts.
-- Store the reason (e.g. "Slack: not_in_channel", "SendGrid HTTP 401: ...")
-- alongside the existing per-row alert delivery status so admins can triage
-- failures from the change-history tooltip without digging through server logs.
ALTER TABLE "agent_match_setting_history"
  ADD COLUMN IF NOT EXISTS "slack_failure_reason" text,
  ADD COLUMN IF NOT EXISTS "email_failure_reason" text;
