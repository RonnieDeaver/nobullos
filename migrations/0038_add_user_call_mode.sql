-- Task #874: Browser-based VOIP via Twilio Voice JS SDK.
-- Per-user calling mode: 'browser' (default, in-tab via SDK) or 'forward'
-- (legacy bridge to a routing phone number).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS call_mode varchar DEFAULT 'browser' NOT NULL;

-- Backfill existing rows: anyone who already has a callRoutingPhone configured
-- is most likely currently using forward-mode, so preserve their behavior.
-- Everyone else gets the new 'browser' default.
UPDATE users
SET call_mode = 'forward'
WHERE call_mode = 'browser'
  AND call_routing_phone IS NOT NULL
  AND length(trim(call_routing_phone)) > 0;
