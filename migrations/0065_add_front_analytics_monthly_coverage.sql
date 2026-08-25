-- Migration 0065 — Task #1643: Front Analytics all-time coverage.
--
-- Adds a monthly rollup cache keyed by YYYY-MM. Each row holds Front's
-- authoritative monthly message count (`front_total_messages`), plus the
-- two NoBull-local counts (`fetched_into_nobull`, `applied_into_nobull`)
-- and the derived gaps + percentages. Completed months are immutable
-- after first successful pull; current month is upserted on every refresh
-- (see server/services/frontAnalyticsCoverage.ts).
--
-- Measurement-only: this table is never read by the ingestion pipeline
-- and never written back into `front_sync_emails` or
-- `raw_communication_records`.

CREATE TABLE IF NOT EXISTS front_analytics_monthly_coverage (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  month varchar(7) NOT NULL UNIQUE,
  month_start timestamp NOT NULL,
  month_end timestamp NOT NULL,
  front_total_messages integer NOT NULL DEFAULT 0,
  fetched_into_nobull integer NOT NULL DEFAULT 0,
  applied_into_nobull integer NOT NULL DEFAULT 0,
  ingest_gap integer NOT NULL DEFAULT 0,
  apply_gap integer NOT NULL DEFAULT 0,
  fetched_coverage_pct real NOT NULL DEFAULT 0,
  applied_coverage_pct real NOT NULL DEFAULT 0,
  pulled_at timestamp,
  source_run_id varchar,
  is_finalized_month boolean NOT NULL DEFAULT false,
  front_analytics_report_id varchar,
  front_analytics_status varchar,
  front_analytics_error text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT front_analytics_monthly_coverage_counts_nonneg
    CHECK (
      front_total_messages >= 0
      AND fetched_into_nobull >= 0
      AND applied_into_nobull >= 0
    )
);

CREATE INDEX IF NOT EXISTS front_analytics_monthly_coverage_month_idx
  ON front_analytics_monthly_coverage (month);
