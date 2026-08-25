-- Task #3814: per-table size trend samples for the oversized-table watchdog.
-- Written by server/services/tableSizeWatchdog.ts on a 6-hour cadence for
-- every table covered by the table-maintenance policy
-- (server/services/tableMaintenancePolicy.ts). Read by the admin health
-- dashboard's "Size Trend" view. Pruned by the table-retention pruner.
CREATE TABLE IF NOT EXISTS table_size_samples (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  sampled_at bigint NOT NULL,
  table_name varchar(128) NOT NULL,
  total_bytes bigint NOT NULL DEFAULT 0,
  table_bytes bigint NOT NULL DEFAULT 0,
  index_bytes bigint NOT NULL DEFAULT 0,
  live_tuples bigint NOT NULL DEFAULT 0,
  dead_tuples bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_table_size_samples_table_ts
  ON table_size_samples (table_name, sampled_at);

CREATE INDEX IF NOT EXISTS idx_table_size_samples_sampled_at
  ON table_size_samples (sampled_at);

-- Partial indexes backing the Task #3814 retention pruner's eligibility
-- predicates (tableMaintenancePolicy PRUNE_UNITS). Without them every
-- capped eligibility count and every 2000-row batch DELETE subselect is a
-- full-table seq scan (measured ~8s per count on the 379k-row dev
-- work_queue); with them each is a cheap index range scan.
CREATE INDEX IF NOT EXISTS idx_work_queue_terminal_updated_at
  ON work_queue (updated_at)
  WHERE status IN ('completed', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_work_queue_failed_updated_at
  ON work_queue (updated_at)
  WHERE status IN ('failed', 'dead_letter');

CREATE INDEX IF NOT EXISTS idx_source_event_log_terminal_received_at
  ON source_event_log (received_at)
  WHERE status IN ('applied', 'ignored', 'failed', 'dead_lettered');

CREATE INDEX IF NOT EXISTS idx_call_analysis_jobs_terminal_created_at
  ON call_analysis_jobs (created_at)
  WHERE status IN ('complete', 'failed');

CREATE INDEX IF NOT EXISTS idx_mcu_cache_expires_at
  ON mcu_cache (expires_at);
