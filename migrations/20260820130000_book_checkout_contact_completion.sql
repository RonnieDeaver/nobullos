-- Durable proof that a checkout completed the required contact step.
-- Existing pending sessions intentionally remain incomplete and must resubmit
-- contact details before a quote or PaymentIntent can be created.
ALTER TABLE book_checkout_sessions
  ADD COLUMN IF NOT EXISTS contact_completed_at timestamp;

COMMENT ON COLUMN book_checkout_sessions.contact_completed_at IS
  'Server-written proof that the required checkout contact step completed';