-- Task #2686 — Live Data snapshot table for per-client BigQuery metrics.
--
-- One row per (client, period, fetched_at) hourly pull. The `metrics` JSONB
-- column holds an array of { key, label, value, unitLabel, status, reason }
-- objects — one per performance-layer auto-source metric. The UI reads the
-- latest snapshot for the current period plus the last 6 periods for a
-- simple trend view.

CREATE TABLE IF NOT EXISTS live_data_snapshots (
  id            varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     varchar NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Calendar month 'YYYY-MM' the metrics cover (same period semantics as RIS).
  period        varchar(7) NOT NULL,
  fetched_at    timestamp NOT NULL DEFAULT now(),
  -- Overall status of this snapshot pull.
  -- 'ok'              — all metrics pulled successfully
  -- 'partial'         — some metrics ok, some degraded
  -- 'not-configured'  — BigQuery not configured or client has no data key
  -- 'error'           — all metrics failed
  overall_status varchar(32) NOT NULL DEFAULT 'ok',
  -- Array of LiveDataMetric objects (key, label, value, unitLabel, status, reason).
  metrics       jsonb NOT NULL DEFAULT '[]',
  created_at    timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_data_snapshots_client_period_idx
  ON live_data_snapshots(client_id, period);

CREATE INDEX IF NOT EXISTS live_data_snapshots_client_fetched_idx
  ON live_data_snapshots(client_id, fetched_at DESC);
