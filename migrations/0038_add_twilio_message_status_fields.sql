-- Task #875: Twilio SMS delivery-status callback. Persist Twilio's
-- diagnostic info on the message row so the thread view can show the
-- error code as a tooltip when a message ends in `failed` /
-- `undelivered`. Both columns are nullable — old rows that pre-date
-- this task continue to render whatever status they last had.
ALTER TABLE twilio_messages
  ADD COLUMN IF NOT EXISTS error_code varchar,
  ADD COLUMN IF NOT EXISTS error_message text;
