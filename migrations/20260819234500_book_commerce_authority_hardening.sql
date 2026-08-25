-- Task #5096 — Book Commerce Authority Hardening (upgrade-path reconciliation).
--
-- Companion to 20260819203532_book_commerce_foundation.sql.
-- Reconciles tables that may have been created by an earlier push-first
-- schema snapshot (where checkout_session_id / audit_application_id were
-- still nullable SET NULL, and sms_consent_evidence_ref was a plain varchar
-- with no FK) to the current model: NOT NULL authority FKs + explicit
-- ON DELETE RESTRICT FK contracts.
--
-- No edits to the foundation migration — this file is the forward-fix.
--
-- destructive-approved: Task #5096 / schema authority hardening.
--   SET NOT NULL on book_orders.checkout_session_id and
--   book_appointments.audit_application_id is the correct upgrade path
--   for these authority columns. There is no trustworthy backfill — if any
--   NULL rows exist the migration fails loudly (SQLSTATE 23502) with an
--   actionable message. DROP CONSTRAINT is metadata-only: no table, column,
--   or row is deleted; only the FK enforcement rule is replaced with the
--   correct named RESTRICT constraint. Lock strategy: both SET NOT NULL and
--   ADD CONSTRAINT FOREIGN KEY acquire an AccessExclusiveLock on the target
--   table; in production these tables are new and empty at the time of this
--   migration, so the lock is uncontested. For future use on populated
--   tables, schedule during low-traffic windows or use a NOT VALID /
--   VALIDATE CONSTRAINT pattern instead.
--
-- Replay-safety: every ALTER is wrapped in a conditional DO block that
-- checks the current catalog state, so applying this migration to an
-- already-hardened schema (e.g. built from the current model via push-first)
-- is a strict no-op: no error, no redundant DDL.

-- ── §1  Null-residue guards then SET NOT NULL ─────────────────────────────────
--
-- We refuse to proceed if any existing row would violate the new NOT NULL
-- constraint. There is no trustworthy backfill value, so we raise 23502
-- (not_null_violation) with an actionable message and halt.
--
-- Each block:
--   a. check for NULL residue → fail loudly if found.
--   b. set NOT NULL only when the column is currently nullable (catalog check).

-- book_orders.checkout_session_id
DO $$
DECLARE
  v_null_count bigint;
BEGIN
  SELECT count(*) INTO v_null_count
    FROM book_orders WHERE checkout_session_id IS NULL;

  IF v_null_count > 0 THEN
    RAISE EXCEPTION
      'Authority hardening halted: % book_orders row(s) have checkout_session_id IS NULL. '
      'There is no trustworthy backfill — locate the originating checkout sessions and '
      'populate checkout_session_id before re-running this migration.',
      v_null_count
      USING ERRCODE = '23502';
  END IF;

  -- Apply SET NOT NULL only when the column is still nullable.
  IF EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_class     c ON c.oid = a.attrelid
     WHERE c.relname  = 'book_orders'
       AND c.relkind  = 'r'
       AND a.attname  = 'checkout_session_id'
       AND a.attnotnull = false
       AND a.attnum   > 0
       AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_orders ALTER COLUMN checkout_session_id SET NOT NULL;
  END IF;
END;
$$;

-- book_appointments.audit_application_id
DO $$
DECLARE
  v_null_count bigint;
BEGIN
  SELECT count(*) INTO v_null_count
    FROM book_appointments WHERE audit_application_id IS NULL;

  IF v_null_count > 0 THEN
    RAISE EXCEPTION
      'Authority hardening halted: % book_appointments row(s) have audit_application_id IS NULL. '
      'There is no trustworthy backfill — locate the qualifying audit applications and '
      'populate audit_application_id before re-running this migration.',
      v_null_count
      USING ERRCODE = '23502';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_class     c ON c.oid = a.attrelid
     WHERE c.relname  = 'book_appointments'
       AND c.relkind  = 'r'
       AND a.attname  = 'audit_application_id'
       AND a.attnotnull = false
       AND a.attnum   > 0
       AND NOT a.attisdropped
  ) THEN
    ALTER TABLE book_appointments ALTER COLUMN audit_application_id SET NOT NULL;
  END IF;
END;
$$;

-- ── §2  FK contract reconciliation ────────────────────────────────────────────
--
-- For each of the four authority FK columns, this block:
--   1. Checks whether an exact correct FK already exists:
--        - single-column (conkey has exactly one element matching the
--          local attnum for that column name)
--        - references the correct table/PK
--        - confdeltype = 'r' (RESTRICT)
--      If so, skip — nothing to do (no-op on a push-first hardened schema).
--   2. Otherwise, drop every FK constraint that references this local column
--      (regardless of generated name or action type) using dynamic SQL on
--      the constraint catalog — metadata only, no rows deleted.
--   3. Add an explicitly named, correct ON DELETE RESTRICT FK. The ADD
--      CONSTRAINT will fail immediately if any existing row references a
--      missing parent — which is the desired behaviour (fail loudly rather
--      than silently clear links).
--
-- Helper function used by all four blocks (avoids repeated inline queries).
-- CREATE OR REPLACE so it is replay-safe.

CREATE OR REPLACE FUNCTION _bc_drop_fks_for_column(
  p_table  text,
  p_column text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_con record;
  v_sql text;
BEGIN
  FOR v_con IN
    SELECT c.conname
      FROM pg_constraint  c
      JOIN pg_class       t  ON t.oid = c.conrelid
      JOIN pg_attribute   a  ON a.attrelid = t.oid
                             AND a.attnum   = ANY(c.conkey)
                             AND a.attnum   > 0
                             AND NOT a.attisdropped
     WHERE c.contype  = 'f'
       AND t.relkind  = 'r'
       AND t.relname  = p_table
       AND a.attname  = p_column
       -- only single-column FKs (defensive: our schema never uses
       -- composite FKs on these four columns)
       AND array_length(c.conkey, 1) = 1
  LOOP
    v_sql := format('ALTER TABLE %I DROP CONSTRAINT %I', p_table, v_con.conname);
    EXECUTE v_sql;
    RAISE NOTICE 'Dropped stale FK: %.% constraint %',
      p_table, p_column, v_con.conname;
  END LOOP;
END;
$$;

-- ── §2a  book_orders.checkout_session_id → book_checkout_sessions(id) RESTRICT

DO $$
DECLARE
  v_local_attnum  smallint;
  v_ref_reloid    oid;
  v_ref_attnum    smallint;
  v_correct_exists boolean := false;
BEGIN
  -- Attnum of the local column.
  SELECT a.attnum INTO v_local_attnum
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
   WHERE c.relname  = 'book_orders'
     AND c.relkind  = 'r'
     AND a.attname  = 'checkout_session_id'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

  -- OID of the referenced table.
  SELECT c.oid INTO v_ref_reloid
    FROM pg_class c WHERE c.relname = 'book_checkout_sessions' AND c.relkind = 'r';

  -- Attnum of the referenced id column (so we verify confkey, not just confrelid).
  SELECT a.attnum INTO v_ref_attnum
    FROM pg_attribute a
   WHERE a.attrelid = v_ref_reloid
     AND a.attname  = 'id'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

  -- Check for an existing correct FK (local column, referenced table AND PK).
  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
     WHERE c.contype          = 'f'
       AND t.relname          = 'book_orders'
       AND c.confrelid        = v_ref_reloid
       AND c.conkey           = ARRAY[v_local_attnum]
       AND c.confkey          = ARRAY[v_ref_attnum]
       AND c.confdeltype      = 'r'
       AND array_length(c.conkey, 1) = 1
       AND array_length(c.confkey, 1) = 1
  ) INTO v_correct_exists;

  IF v_correct_exists THEN
    RAISE NOTICE 'book_orders.checkout_session_id: correct RESTRICT FK already exists — skipping.';
  ELSE
    PERFORM _bc_drop_fks_for_column('book_orders', 'checkout_session_id');
    ALTER TABLE book_orders
      ADD CONSTRAINT book_orders_checkout_session_id_fk
        FOREIGN KEY (checkout_session_id)
        REFERENCES book_checkout_sessions(id)
        ON DELETE RESTRICT;
    RAISE NOTICE 'book_orders.checkout_session_id: added book_orders_checkout_session_id_fk (RESTRICT).';
  END IF;
END;
$$;

-- ── §2b  book_appointments.audit_application_id → book_audit_applications(id) RESTRICT

DO $$
DECLARE
  v_local_attnum  smallint;
  v_ref_reloid    oid;
  v_ref_attnum    smallint;
  v_correct_exists boolean := false;
BEGIN
  SELECT a.attnum INTO v_local_attnum
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
   WHERE c.relname  = 'book_appointments'
     AND c.relkind  = 'r'
     AND a.attname  = 'audit_application_id'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

  SELECT c.oid INTO v_ref_reloid
    FROM pg_class c WHERE c.relname = 'book_audit_applications' AND c.relkind = 'r';

  -- Attnum of the referenced id column (so we verify confkey, not just confrelid).
  SELECT a.attnum INTO v_ref_attnum
    FROM pg_attribute a
   WHERE a.attrelid = v_ref_reloid
     AND a.attname  = 'id'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
     WHERE c.contype          = 'f'
       AND t.relname          = 'book_appointments'
       AND c.confrelid        = v_ref_reloid
       AND c.conkey           = ARRAY[v_local_attnum]
       AND c.confkey          = ARRAY[v_ref_attnum]
       AND c.confdeltype      = 'r'
       AND array_length(c.conkey, 1) = 1
       AND array_length(c.confkey, 1) = 1
  ) INTO v_correct_exists;

  IF v_correct_exists THEN
    RAISE NOTICE 'book_appointments.audit_application_id: correct RESTRICT FK already exists — skipping.';
  ELSE
    PERFORM _bc_drop_fks_for_column('book_appointments', 'audit_application_id');
    ALTER TABLE book_appointments
      ADD CONSTRAINT book_appointments_audit_application_id_fk
        FOREIGN KEY (audit_application_id)
        REFERENCES book_audit_applications(id)
        ON DELETE RESTRICT;
    RAISE NOTICE 'book_appointments.audit_application_id: added book_appointments_audit_application_id_fk (RESTRICT).';
  END IF;
END;
$$;

-- ── §2c  book_contacts.sms_consent_evidence_ref → sms_consent_ledger(id) RESTRICT

DO $$
DECLARE
  v_local_attnum  smallint;
  v_ref_reloid    oid;
  v_ref_attnum    smallint;
  v_correct_exists boolean := false;
BEGIN
  SELECT a.attnum INTO v_local_attnum
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
   WHERE c.relname  = 'book_contacts'
     AND c.relkind  = 'r'
     AND a.attname  = 'sms_consent_evidence_ref'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

  SELECT c.oid INTO v_ref_reloid
    FROM pg_class c WHERE c.relname = 'sms_consent_ledger' AND c.relkind = 'r';

  -- Attnum of the referenced id column (so we verify confkey, not just confrelid).
  SELECT a.attnum INTO v_ref_attnum
    FROM pg_attribute a
   WHERE a.attrelid = v_ref_reloid
     AND a.attname  = 'id'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
     WHERE c.contype          = 'f'
       AND t.relname          = 'book_contacts'
       AND c.confrelid        = v_ref_reloid
       AND c.conkey           = ARRAY[v_local_attnum]
       AND c.confkey          = ARRAY[v_ref_attnum]
       AND c.confdeltype      = 'r'
       AND array_length(c.conkey, 1) = 1
       AND array_length(c.confkey, 1) = 1
  ) INTO v_correct_exists;

  IF v_correct_exists THEN
    RAISE NOTICE 'book_contacts.sms_consent_evidence_ref: correct RESTRICT FK already exists — skipping.';
  ELSE
    PERFORM _bc_drop_fks_for_column('book_contacts', 'sms_consent_evidence_ref');
    ALTER TABLE book_contacts
      ADD CONSTRAINT book_contacts_sms_consent_evidence_ref_fk
        FOREIGN KEY (sms_consent_evidence_ref)
        REFERENCES sms_consent_ledger(id)
        ON DELETE RESTRICT;
    RAISE NOTICE 'book_contacts.sms_consent_evidence_ref: added book_contacts_sms_consent_evidence_ref_fk (RESTRICT).';
  END IF;
END;
$$;

-- ── §2d  book_orders.sms_consent_evidence_ref → sms_consent_ledger(id) RESTRICT

DO $$
DECLARE
  v_local_attnum  smallint;
  v_ref_reloid    oid;
  v_ref_attnum    smallint;
  v_correct_exists boolean := false;
BEGIN
  SELECT a.attnum INTO v_local_attnum
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
   WHERE c.relname  = 'book_orders'
     AND c.relkind  = 'r'
     AND a.attname  = 'sms_consent_evidence_ref'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

  SELECT c.oid INTO v_ref_reloid
    FROM pg_class c WHERE c.relname = 'sms_consent_ledger' AND c.relkind = 'r';

  -- Attnum of the referenced id column (so we verify confkey, not just confrelid).
  SELECT a.attnum INTO v_ref_attnum
    FROM pg_attribute a
   WHERE a.attrelid = v_ref_reloid
     AND a.attname  = 'id'
     AND a.attnum   > 0
     AND NOT a.attisdropped;

  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
     WHERE c.contype          = 'f'
       AND t.relname          = 'book_orders'
       AND c.confrelid        = v_ref_reloid
       AND c.conkey           = ARRAY[v_local_attnum]
       AND c.confkey          = ARRAY[v_ref_attnum]
       AND c.confdeltype      = 'r'
       AND array_length(c.conkey, 1) = 1
       AND array_length(c.confkey, 1) = 1
  ) INTO v_correct_exists;

  IF v_correct_exists THEN
    RAISE NOTICE 'book_orders.sms_consent_evidence_ref: correct RESTRICT FK already exists — skipping.';
  ELSE
    PERFORM _bc_drop_fks_for_column('book_orders', 'sms_consent_evidence_ref');
    ALTER TABLE book_orders
      ADD CONSTRAINT book_orders_sms_consent_evidence_ref_fk
        FOREIGN KEY (sms_consent_evidence_ref)
        REFERENCES sms_consent_ledger(id)
        ON DELETE RESTRICT;
    RAISE NOTICE 'book_orders.sms_consent_evidence_ref: added book_orders_sms_consent_evidence_ref_fk (RESTRICT).';
  END IF;
END;
$$;

-- ── §3  Cleanup ───────────────────────────────────────────────────────────────
-- Drop the transient helper function (no longer needed after this migration).
DROP FUNCTION IF EXISTS _bc_drop_fks_for_column(text, text);
