-- Task #4478 — AI-personalized sequence drafts for the approval queue.
--
-- Additive + idempotent:
--   * email_sequence_steps.ai_personalization_enabled — per-step opt-in to
--     AI-personalize the template against the contact/client/deal context.
--     AI-enabled steps ALWAYS land in the approval queue (auto-send stays
--     template-only).
--   * email_sequence_step_sends.ai_personalized — whether the frozen draft
--     content is AI output (approval-queue badge / provenance).

ALTER TABLE email_sequence_steps
  ADD COLUMN IF NOT EXISTS ai_personalization_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE email_sequence_step_sends
  ADD COLUMN IF NOT EXISTS ai_personalized boolean NOT NULL DEFAULT false;
