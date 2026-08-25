-- Task #3896 (audit B-003): durable dispatch-claim identity for outbound
-- Twilio REST creates. The claim columns give each outbound send/call a
-- local row identity BEFORE the Twilio API call so a crash, retry, or
-- concurrent invocation can never create two Twilio resources for one
-- logical operation. Additive + idempotent. NULL on all historical rows,
-- inbound rows, and settled rows (claims are cleared on finalize/fail).
ALTER TABLE twilio_messages ADD COLUMN IF NOT EXISTS dispatch_claim_token varchar;
ALTER TABLE twilio_messages ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamp;
ALTER TABLE twilio_calls ADD COLUMN IF NOT EXISTS dispatch_claim_token varchar;
ALTER TABLE twilio_calls ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamp;
