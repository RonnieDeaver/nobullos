-- Task #3816: persisted per-route API request-metrics windows.
-- The in-process rolling aggregator (server/services/requestMetrics.ts)
-- flushes one row per active route (plus the `_ALL_` aggregate) every
-- 5 minutes: request count, 4xx/5xx counts, and p50/p95/max/avg latency
-- for that window. Read by the System Health Console's "API Route
-- Metrics" panel; rows older than 14 days are pruned by the flusher.
CREATE TABLE IF NOT EXISTS api_route_stats_windows (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  window_started_at bigint NOT NULL,
  window_ms integer NOT NULL DEFAULT 0,
  route varchar(180) NOT NULL,
  count integer NOT NULL DEFAULT 0,
  err_4xx integer NOT NULL DEFAULT 0,
  err_5xx integer NOT NULL DEFAULT 0,
  p50_ms integer NOT NULL DEFAULT 0,
  p95_ms integer NOT NULL DEFAULT 0,
  max_ms integer NOT NULL DEFAULT 0,
  avg_ms integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_route_stats_windows_started_at
  ON api_route_stats_windows (window_started_at);

CREATE INDEX IF NOT EXISTS idx_api_route_stats_windows_route_ts
  ON api_route_stats_windows (route, window_started_at);
