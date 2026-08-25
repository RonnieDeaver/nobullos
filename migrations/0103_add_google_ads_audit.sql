-- Tasks #2784 / #2785 — Google Ads Hygiene tables (google_ads_audit_runs,
-- google_ads_audit_check_results, google_ads_hygiene_alerts,
-- google_ads_keyword_intel_results).
--
-- These tables shipped via drizzle-kit push only (no migration file), which
-- made every non-interactive `drizzle-kit push` in scripts/post-merge.sh hang
-- on the create-vs-rename prompt. This file pre-creates them idempotently so
-- push sees them as existing. Mirrors shared/models/googleAdsAudit.ts and
-- shared/models/googleAdsHygiene.ts exactly.
--
-- Fully idempotent: safe for scripts/post-merge.sh SAFE_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "google_ads_audit_runs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "status" varchar NOT NULL DEFAULT 'running',
  "started_at" timestamp NOT NULL DEFAULT now(),
  "finished_at" timestamp,
  "triggered_by" varchar,
  "score_h" double precision,
  "score_h_final" double precision,
  "category_scores" jsonb,
  "triggered_gates" jsonb,
  "error" text,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "google_ads_audit_runs_customer_idx"
  ON "google_ads_audit_runs" ("customer_id");
CREATE INDEX IF NOT EXISTS "google_ads_audit_runs_started_at_idx"
  ON "google_ads_audit_runs" ("started_at");

CREATE TABLE IF NOT EXISTS "google_ads_audit_check_results" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" varchar NOT NULL,
  "check_id" varchar NOT NULL,
  "category_id" varchar NOT NULL,
  "status" varchar NOT NULL,
  "score" double precision,
  "weight" double precision NOT NULL DEFAULT 0,
  "measured_value" text,
  "measured_numeric" double precision,
  "affected_entities" jsonb,
  "recommended_fix" text,
  "is_gate" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "google_ads_audit_check_results_run_idx"
  ON "google_ads_audit_check_results" ("run_id");
CREATE INDEX IF NOT EXISTS "google_ads_audit_check_results_run_check_idx"
  ON "google_ads_audit_check_results" ("run_id", "check_id");

CREATE TABLE IF NOT EXISTS "google_ads_hygiene_alerts" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "alert_type" varchar NOT NULL,
  "severity" varchar NOT NULL DEFAULT 'warning',
  "title" text NOT NULL,
  "detail" text,
  "campaign_id" varchar,
  "campaign_name" text,
  "measured_value" text,
  "is_resolved" varchar NOT NULL DEFAULT 'no',
  "resolved_at" timestamp,
  "clickup_task_id" varchar,
  "clickup_list_id" varchar,
  "clickup_task_status" varchar,
  "clickup_task_url" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "google_ads_hygiene_alerts_customer_idx"
  ON "google_ads_hygiene_alerts" ("customer_id");
CREATE INDEX IF NOT EXISTS "google_ads_hygiene_alerts_created_at_idx"
  ON "google_ads_hygiene_alerts" ("created_at");

CREATE TABLE IF NOT EXISTS "google_ads_keyword_intel_results" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "run_at" timestamp NOT NULL DEFAULT now(),
  "campaign_id" varchar,
  "campaign_name" text,
  "ad_group_id" varchar,
  "keyword_text" text NOT NULL,
  "match_type" varchar,
  "impressions" integer NOT NULL DEFAULT 0,
  "clicks" integer NOT NULL DEFAULT 0,
  "cost_dollars" double precision NOT NULL DEFAULT 0,
  "conversions" integer NOT NULL DEFAULT 0,
  "avg_cpc_dollars" double precision NOT NULL DEFAULT 0,
  "quality_score" integer,
  "suggestion_type" varchar NOT NULL,
  "notes" text,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "google_ads_keyword_intel_customer_run_idx"
  ON "google_ads_keyword_intel_results" ("customer_id", "run_at");
CREATE INDEX IF NOT EXISTS "google_ads_keyword_intel_customer_idx"
  ON "google_ads_keyword_intel_results" ("customer_id");
