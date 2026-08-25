-- Task #4765 — open-ask source pipeline: burst-race dedup constraint +
-- full-hindsight closure checkpoint column.
--
-- 1. `hindsight_checked_at`: stamped when the hindsight closure sweep has
--    evaluated a row against full communication history (any disposition,
--    including still-live). NULL = not yet groomed; the retro-groom prod
--    action converges on this being NULL-free across sweepable rows.
-- 2. Merge pre-existing EXACT-normalized duplicate active rows (keep the
--    oldest row per (client_id, normalized summary); later mints absorb
--    their mention counts / source ids into the keeper and are dismissed
--    with an audited note). Required before the unique index can build.
-- 3. Partial unique index: two concurrent extractions of the byte-identical
--    ask cannot double-insert while a sweepable-status row exists.
--
-- Idempotent: re-running finds no remaining duplicate active rows (step 2's
-- WHERE matches nothing) and IF NOT EXISTS guards steps 1 and 3.

ALTER TABLE client_open_asks
  ADD COLUMN IF NOT EXISTS hindsight_checked_at timestamp;

-- Step 2a: absorb duplicate rows' tallies into the keeper (oldest row wins).
WITH ranked AS (
  SELECT id,
         client_id,
         md5(lower(btrim(summary))) AS norm,
         mention_count,
         source_record_ids,
         ROW_NUMBER() OVER (
           PARTITION BY client_id, md5(lower(btrim(summary)))
           ORDER BY created_at ASC, id ASC
         ) AS rn,
         FIRST_VALUE(id) OVER (
           PARTITION BY client_id, md5(lower(btrim(summary)))
           ORDER BY created_at ASC, id ASC
         ) AS keeper_id
  FROM client_open_asks
  WHERE status IN ('open', 'likely_open', 'likely_resolved')
),
dupes AS (
  SELECT keeper_id,
         SUM(COALESCE(mention_count, 1)) AS extra_mentions,
         ARRAY(
           SELECT DISTINCT unnested
           FROM ranked r2, unnest(COALESCE(r2.source_record_ids, '{}')) AS unnested
           WHERE r2.keeper_id = ranked.keeper_id AND r2.rn > 1
         ) AS extra_sources
  FROM ranked
  WHERE rn > 1
  GROUP BY keeper_id
)
UPDATE client_open_asks k
SET mention_count = COALESCE(k.mention_count, 1) + d.extra_mentions,
    source_record_ids = (
      SELECT ARRAY(
        SELECT DISTINCT s FROM unnest(COALESCE(k.source_record_ids, '{}') || d.extra_sources) AS s
      )
    ),
    updated_at = NOW()
FROM dupes d
WHERE k.id = d.keeper_id;

-- Step 2b: dismiss the absorbed duplicates with an audited disposition.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY client_id, md5(lower(btrim(summary)))
           ORDER BY created_at ASC, id ASC
         ) AS rn,
         FIRST_VALUE(id) OVER (
           PARTITION BY client_id, md5(lower(btrim(summary)))
           ORDER BY created_at ASC, id ASC
         ) AS keeper_id
  FROM client_open_asks
  WHERE status IN ('open', 'likely_open', 'likely_resolved')
)
UPDATE client_open_asks a
SET status = 'dismissed',
    resolution_note = 'Merged duplicate of ' || r.keeper_id || ' (Task #4765 exact-duplicate migration merge)',
    resolved_at = NOW(),
    updated_at = NOW()
FROM ranked r
WHERE a.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS client_open_asks_active_summary_uniq
  ON client_open_asks (client_id, md5(lower(btrim(summary))))
  WHERE status IN ('open', 'likely_open', 'likely_resolved');
