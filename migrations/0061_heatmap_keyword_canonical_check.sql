-- Migration 0061: enforce canonical keyword spellings in heatmap_snapshots
-- (Task #1241).
--
-- Task #791 added an application-level normalization (`normalizeKeyword`) and
-- a one-shot cleanup script (`scripts/cleanup-legacy-keyword-spellings.ts`)
-- that rewrote legacy non-canonical `keyword_name` values to their canonical
-- (trimmed, internal-whitespace-collapsed, lowercased) form. The write path
-- always normalizes before insert, but nothing at the database level stopped
-- a future code path — or a hand-written backfill — from inserting a raw
-- spelling like "Plumber" or "  plumber  " again.
--
-- This migration makes the invariant durable:
--   1. Re-runs the same cleanup UPDATE the script performs, so any rows that
--      slipped in between #791 deploying and this migration running are
--      rewritten to canonical form. Idempotent — the WHERE clause skips
--      already-canonical rows, so re-applying the migration is a no-op.
--   2. Adds a CHECK constraint that requires `keyword_name` to already equal
--      `lower(regexp_replace(btrim(keyword_name), '\s+', ' ', 'g'))`. Any
--      future INSERT or UPDATE that tries to land a non-canonical spelling
--      will fail loudly with a constraint violation instead of silently
--      reintroducing duplicate spellings.
--
-- The canonical form mirrors `normalizeKeyword` in
-- `shared/keywordNormalization.ts` exactly: trim leading/trailing whitespace,
-- collapse runs of internal whitespace to a single ASCII space, lowercase.
-- If that helper ever changes, this constraint must be updated in lockstep.

BEGIN;

-- Step 1: cleanup pass — rewrite any remaining non-canonical rows so the
-- CHECK constraint can be added without violations. Same predicate and
-- expression as scripts/cleanup-legacy-keyword-spellings.ts.
UPDATE heatmap_snapshots
SET keyword_name = lower(regexp_replace(btrim(keyword_name), '\s+', ' ', 'g'))
WHERE keyword_name <> lower(regexp_replace(btrim(keyword_name), '\s+', ' ', 'g'));

-- Step 2: durable DB-level guard. NOT VALID would defer the existing-row
-- check, but step 1 just rewrote every offending row, so a plain CHECK is
-- safe and rejects future non-canonical writes immediately.
ALTER TABLE heatmap_snapshots
  ADD CONSTRAINT heatmap_snapshots_keyword_name_canonical_chk
  CHECK (keyword_name = lower(regexp_replace(btrim(keyword_name), '\s+', ' ', 'g')));

COMMIT;
