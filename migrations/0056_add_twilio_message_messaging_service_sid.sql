-- Task #883: record which Twilio transport an outbound SMS actually went
-- through (Messaging Service / RCS-ready Sender Pool vs single From phone).
--
-- The existing `from_number` column is preserved as-is because inbound
-- thread matching depends on it (replies always come back as SMS to the
-- configured Twilio number regardless of outbound transport). The new
-- `messaging_service_sid` column is mutually exclusive with `from_number`
-- as a "real sender" indicator: when set, the message went out through
-- the Messaging Service; when NULL on an outbound row, the legacy
-- single-number path was used. Always NULL on inbound rows.
--
-- Populated on insert by `sendSms` and on every subsequent
-- delivery-status callback (which carries `MessagingServiceSid` for
-- messages routed through a service), so historical rows pre-#883 get
-- backfilled the next time a status callback fires.
ALTER TABLE twilio_messages
  ADD COLUMN IF NOT EXISTS messaging_service_sid varchar;
