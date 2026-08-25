-- Add call_type to comms_calls to distinguish voice vs video calls
ALTER TABLE comms_calls ADD COLUMN IF NOT EXISTS call_type VARCHAR(16) DEFAULT 'voice';
