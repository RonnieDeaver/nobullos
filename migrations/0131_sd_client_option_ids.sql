-- Task #3393 — Service Desk Client field → dropdown with ID mapping
-- Adds clientOptionIds jsonb column to sd_list_mapping to store the
-- ClickUp option UUID → NoBull clients.id map for the Client dropdown field.

ALTER TABLE "sd_list_mapping" ADD COLUMN IF NOT EXISTS "client_option_ids" jsonb;
