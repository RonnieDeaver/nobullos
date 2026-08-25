-- Task #3698: the partial UNIQUE index that arbitrates
-- ON CONFLICT (external_source_id) inserts into raw_communication_records is
-- bootstrap-managed raw SQL (server/index.ts ensureExternalSourceIdUnique) and
-- intentionally absent from shared/schema.ts. It drifted out of the dev DB,
-- which broke every ON CONFLICT insert (and the two gated Front materializer
-- suites, since isolated-schema clones inherit the drift and NODE_ENV=test
-- skips the bootstrap self-heal). This migration makes the restoration
-- reproducible from version control. Idempotent; matches the bootstrap SQL
-- exactly.

-- Remove any duplicate rows that would block the unique index (keep oldest).
DELETE FROM raw_communication_records
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY external_source_id
      ORDER BY created_at ASC
    ) AS rn
    FROM raw_communication_records
    WHERE external_source_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS raw_comm_external_source_id_unique_idx
ON raw_communication_records (external_source_id)
WHERE external_source_id IS NOT NULL;
