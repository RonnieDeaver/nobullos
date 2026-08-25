-- Migration 0064 — Audit Track C (Task #1573): targeted hot-path indexes.
--
-- All indexes use CREATE INDEX IF NOT EXISTS so the migration is safe to
-- re-apply and produces no table rewrite. CONCURRENTLY is intentionally
-- omitted because (a) the Drizzle migration runner wraps each file in a
-- transaction and CONCURRENTLY is illegal inside a transaction, and (b) the
-- target tables are modest in size on Helium Postgres today (call_analysis_jobs
-- ~ tens of thousands, ai_suggestions ~ low six figures, client_contacts ~ low
-- four figures, communication_client_links ~ low six figures). Operators that
-- want to apply this concurrently in production can run the equivalent
-- `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` statements out of band, then
-- mark this migration as applied — they are pure additions with no schema
-- coupling beyond the index name.
--
-- Reversible: each index can be dropped with `DROP INDEX IF EXISTS <name>` if
-- a regression is observed. No data is rewritten and no constraint is added.
-- Backfill impact: none; these are pure read-path accelerators.

-- call_analysis_jobs: the normal-lane and slow-lane pollers in
-- server/services/callAnalysis.ts query `WHERE status='queued' AND lane=?
-- AND (locked_until IS NULL OR locked_until <= now()) ORDER BY created_at`
-- on every tick. The table has no non-PK indexes today, so every poll is
-- a Seq Scan that grows linearly with the job log.
CREATE INDEX IF NOT EXISTS call_analysis_jobs_status_lane_created_idx
  ON call_analysis_jobs (status, lane, created_at);

-- ai_suggestions: listAiSuggestions and countPendingSuggestions filter on
-- (client_id, status) and order by created_at DESC. The two existing
-- single-column indexes force a bitmap heap scan per request.
CREATE INDEX IF NOT EXISTS ai_suggestions_client_status_created_idx
  ON ai_suggestions (client_id, status, created_at DESC);

-- client_contacts: AM/primary-contact resolution during message ingestion
-- and the Conversation Hub's "primary contact" badge both filter on
-- (client_id, is_primary). The bare (client_id) index works but every
-- match has to be filtered for is_primary in memory.
CREATE INDEX IF NOT EXISTS client_contacts_client_primary_idx
  ON client_contacts (client_id, is_primary);

-- communication_client_links: listRawCommunications joins against this
-- table filtering by (client_id, status <> 'rejected'). The bare
-- (client_id) index leaves the status filter for in-memory checking on
-- every row.
CREATE INDEX IF NOT EXISTS comm_client_link_client_status_idx
  ON communication_client_links (client_id, status);
