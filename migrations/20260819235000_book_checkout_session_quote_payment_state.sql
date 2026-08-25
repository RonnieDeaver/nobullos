-- Task #5097 — Book Checkout Session: authoritative quote + payment state.
-- destructive-approved: Task #5097 owner-approved checkout hardening; add nullable, backfill every existing row from the immutable catalog total, then SET NOT NULL in the same migration transaction (the table is newly introduced by the immediately preceding foundation migration).
--
-- Extends book_checkout_sessions ADDITIVELY with server-owned quote and
-- payment-state fields, and replaces the old catalog-total guard with a
-- subtotal-component guard plus the formula-derived total.
--
-- New columns:
--   subtotal_amount_cents     — server-owned catalog subtotal component (NOT NULL,
--                               backfilled from amount_total_cents; same value
--                               for current fixed catalog).
--   discount_amount_cents     — server-owned discount component (default 0).
--   shipping_amount_cents     — server-owned shipping component (default 0).
--   tax_amount_cents          — server-owned tax component (default 0).
--   quote_version             — monotonic CAS version for optimistic locking.
--   quote_expires_at          — when the quoted total expires.
--   stripe_tax_calculation_id — optional Stripe Tax calculation correlation ID.
--   address_snapshot          — JSONB snapshot of the shipping/billing address
--                               at quote time.
--   payment_state             — authoritative payment lifecycle state.
--   payment_error             — durable last payment error string.
--   payment_unknown_reason    — durable unknown/unmatched state reason.
--   reconciliation_note       — durable reconciliation note (manual or auto).
--   payment_intent_id         — alias view: reuses provider_session_id as the
--                               external PaymentIntent ID; no rename/new column.
--
-- Catalog-guard change:
--   OLD: amount_total_cents locked to (digital=499, complete=1999)
--   NEW: subtotal_amount_cents locked to (digital=499, complete=1999) and
--        total = subtotal - discount + shipping + tax (formula).
--   amount_total_cents is now left as an unrestricted non-negative column
--   (amount_check still applies) so historical rows are backfill-safe.
--
-- Replay safety:
--   Every ADD COLUMN is inside a DO block that checks pg_attribute; every
--   ADD CONSTRAINT / ADD INDEX is inside a DO block that checks pg_constraint /
--   pg_indexes. Running this migration against a schema that already has all
--   these changes is a strict no-op. Running it against the original
--   20260819203532 schema applies all changes correctly.
--
-- Ordering: filename 20260819235000 runs AFTER 20260819203532 (foundation) and
--   20260819234500 (authority-hardening) by timestamp. The catalog-guard DROP
--   requires the table to already exist; both prior migrations are prerequisites.

-- ── §1  Add new columns (idempotent; each guarded by pg_attribute check) ────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'subtotal_amount_cents' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS subtotal_amount_cents integer;
    -- Backfill from existing amount_total_cents (same value for current catalog).
    UPDATE book_checkout_sessions
       SET subtotal_amount_cents = amount_total_cents
     WHERE subtotal_amount_cents IS NULL;
    ALTER TABLE book_checkout_sessions
      ALTER COLUMN subtotal_amount_cents SET NOT NULL;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'discount_amount_cents' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS discount_amount_cents integer NOT NULL DEFAULT 0;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'shipping_amount_cents' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS shipping_amount_cents integer NOT NULL DEFAULT 0;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'tax_amount_cents' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS tax_amount_cents integer NOT NULL DEFAULT 0;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'quote_version' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS quote_version integer NOT NULL DEFAULT 0;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'quote_expires_at' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS quote_expires_at timestamp;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'stripe_tax_calculation_id' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS stripe_tax_calculation_id varchar(256);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'address_snapshot' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS address_snapshot jsonb;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'payment_state' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS payment_state varchar(32) NOT NULL DEFAULT 'none';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'payment_error' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS payment_error text;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'payment_unknown_reason' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS payment_unknown_reason text;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r'
       AND a.attname = 'reconciliation_note' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD COLUMN IF NOT EXISTS reconciliation_note text;
  END IF;
END;
$$;

-- ── §2  Replace the catalog guard ────────────────────────────────────────────
--
-- OLD guard: amount_total_cents locked to catalog prices.
-- NEW guards:
--   (a) subtotal_catalog_guard — subtotal_amount_cents locked to catalog prices.
--   (b) component checks — all components >= 0; discount <= subtotal.
--   (c) total formula — amount_total_cents = subtotal - discount + shipping + tax.
--
-- The old book_checkout_sessions_catalog_guard_check is dropped only when it
-- exists; the new constraints are added only when they do not already exist.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_catalog_guard_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      DROP CONSTRAINT book_checkout_sessions_catalog_guard_check;
    RAISE NOTICE 'Dropped old book_checkout_sessions_catalog_guard_check.';
  END IF;
END;
$$;

-- Subtotal catalog guard (replaces old total guard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_subtotal_catalog_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_subtotal_catalog_check
        CHECK (
          currency = 'USD' AND (
            (package_code = 'digital'  AND subtotal_amount_cents =  499) OR
            (package_code = 'complete' AND subtotal_amount_cents = 1999)
          )
        );
  END IF;
END;
$$;

-- Component non-negative checks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_subtotal_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_subtotal_check
        CHECK (subtotal_amount_cents >= 0);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_discount_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_discount_check
        CHECK (discount_amount_cents >= 0 AND discount_amount_cents <= subtotal_amount_cents);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_shipping_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_shipping_check
        CHECK (shipping_amount_cents >= 0);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_tax_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_tax_check
        CHECK (tax_amount_cents >= 0);
  END IF;
END;
$$;

-- Total formula check (amount_total_cents = subtotal - discount + shipping + tax).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_total_formula_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_total_formula_check
        CHECK (amount_total_cents = subtotal_amount_cents - discount_amount_cents + shipping_amount_cents + tax_amount_cents);
  END IF;
END;
$$;

-- payment_state check (closed enum).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_payment_state_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_payment_state_check
        CHECK (payment_state IN ('none','intent_created','processing','captured','failed','canceled','unknown','reconciliation_needed'));
  END IF;
END;
$$;

-- quote_version non-negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'book_checkout_sessions'
       AND c.conname = 'book_checkout_sessions_quote_version_check'
  ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_quote_version_check
        CHECK (quote_version >= 0);
  END IF;
END;
$$;

-- ── §3  Indexes ────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'book_checkout_sessions'
       AND indexname = 'book_checkout_sessions_payment_state_idx'
  ) THEN
    CREATE INDEX IF NOT EXISTS book_checkout_sessions_payment_state_idx
      ON book_checkout_sessions (payment_state);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'book_checkout_sessions'
       AND indexname = 'book_checkout_sessions_quote_expires_at_idx'
  ) THEN
    CREATE INDEX IF NOT EXISTS book_checkout_sessions_quote_expires_at_idx
      ON book_checkout_sessions (quote_expires_at)
     WHERE quote_expires_at IS NOT NULL;
  END IF;
END;
$$;
