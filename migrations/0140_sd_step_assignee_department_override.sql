-- Task #3656 (follow-up): per-step department override for dynamic role
-- assignees on template checklist steps. NULL = resolve against the ticket's
-- own department (previous behavior). Idempotent.
ALTER TABLE sd_request_type_checklist_steps
  ADD COLUMN IF NOT EXISTS assignee_department_id varchar;
