-- Add group messaging fields to twilio_conversations
-- Safe to re-run: uses IF NOT EXISTS / column existence checks

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'twilio_conversations' AND column_name = 'conversation_type'
  ) THEN
    ALTER TABLE twilio_conversations ADD COLUMN conversation_type varchar DEFAULT 'direct';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'twilio_conversations' AND column_name = 'participants'
  ) THEN
    ALTER TABLE twilio_conversations ADD COLUMN participants jsonb;
  END IF;
END $$;
