-- Task #3551 — Service Desk form: Client dropdown from ClickUp
-- Stores the ClickUp option UUID → option name map alongside the existing
-- clientOptionIds map so the submission form can display option labels for
-- both mapped and unmapped options without hitting the ClickUp API at load time.

ALTER TABLE "sd_list_mapping" ADD COLUMN IF NOT EXISTS "client_option_names" jsonb;
