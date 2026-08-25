-- Task #3656: template checklist step assignees + richer intake questions.
--
--   1. sd_request_type_checklist_steps.assignee_user_id — fixed NoBull user
--      to assign the applied ClickUp checklist item to.
--   2. sd_request_type_checklist_steps.assignee_role — dynamic role token
--      ('doer' | 'checker' | 'supervisor') resolved at apply time from
--      sd_client_dept_assignments for the ticket's client + department.
--      Mutually exclusive with assignee_user_id; both NULL = unassigned.
--   3. sd_request_type_questions.help_text / placeholder / default_value —
--      richer intake question configuration for the native submission form.
--
-- Idempotent: safe to re-run.

ALTER TABLE sd_request_type_checklist_steps
  ADD COLUMN IF NOT EXISTS assignee_user_id VARCHAR;

ALTER TABLE sd_request_type_checklist_steps
  ADD COLUMN IF NOT EXISTS assignee_role VARCHAR;

ALTER TABLE sd_request_type_questions
  ADD COLUMN IF NOT EXISTS help_text TEXT;

ALTER TABLE sd_request_type_questions
  ADD COLUMN IF NOT EXISTS placeholder TEXT;

ALTER TABLE sd_request_type_questions
  ADD COLUMN IF NOT EXISTS default_value TEXT;
