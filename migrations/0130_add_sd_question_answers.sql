-- Task #3397 — Show intake question answers inline on the ticket detail view
-- Stores structured [{ label, value }] answers captured at native submission.

ALTER TABLE "sd_ticket_mapping" ADD COLUMN IF NOT EXISTS "question_answers" jsonb;
