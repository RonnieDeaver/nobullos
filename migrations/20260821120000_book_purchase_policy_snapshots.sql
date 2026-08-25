-- Task #5108 — immutable purchase-time policy/disclosure snapshots.
-- Additive and replay-safe: legacy sessions/orders remain NULL; every new
-- checkout is server-stamped before it can reach payment.

ALTER TABLE IF EXISTS book_checkout_sessions
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb;

ALTER TABLE IF EXISTS book_orders
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb;

DO $$
BEGIN
  IF to_regclass('book_checkout_sessions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'book_checkout_sessions_policy_snapshot_object_check'
     ) THEN
    ALTER TABLE book_checkout_sessions
      ADD CONSTRAINT book_checkout_sessions_policy_snapshot_object_check
      CHECK (policy_snapshot IS NULL OR jsonb_typeof(policy_snapshot) = 'object');
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('book_orders') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'book_orders_policy_snapshot_object_check'
     ) THEN
    ALTER TABLE book_orders
      ADD CONSTRAINT book_orders_policy_snapshot_object_check
      CHECK (policy_snapshot IS NULL OR jsonb_typeof(policy_snapshot) = 'object');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reject_book_purchase_policy_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot THEN
    RAISE EXCEPTION '%.policy_snapshot is immutable after insert', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS book_checkout_sessions_policy_snapshot_immutable
  ON book_checkout_sessions;
CREATE TRIGGER book_checkout_sessions_policy_snapshot_immutable
BEFORE UPDATE OF policy_snapshot ON book_checkout_sessions
FOR EACH ROW EXECUTE FUNCTION reject_book_purchase_policy_snapshot_update();

DROP TRIGGER IF EXISTS book_orders_policy_snapshot_immutable
  ON book_orders;
CREATE TRIGGER book_orders_policy_snapshot_immutable
BEFORE UPDATE OF policy_snapshot ON book_orders
FOR EACH ROW EXECUTE FUNCTION reject_book_purchase_policy_snapshot_update();