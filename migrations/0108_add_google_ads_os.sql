-- Task #2958 — Ads OS platform tables (multi-client Google Ads / LSA module
-- at /admin/ads-os). Mirrors shared/models/googleAdsOS.ts exactly.
--
-- Fully idempotent: safe for scripts/post-merge.sh SAFE_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "google_ads_client_mappings" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_name" text NOT NULL,
  "nobull_client_id" varchar,
  "gads_customer_ids" text[] NOT NULL DEFAULT '{}'::text[],
  "lsa_customer_ids" text[] NOT NULL DEFAULT '{}'::text[],
  "lsa_cities" jsonb,
  "monthly_gads_budget" double precision,
  "monthly_lsa_budget" double precision,
  "lsa_budget_split" jsonb,
  "doer_user_id" varchar,
  "checker_user_id" varchar,
  "client_log_url" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_client_mappings_client_name_uq"
  ON "google_ads_client_mappings" ("client_name");

CREATE TABLE IF NOT EXISTS "google_ads_client_criteria" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "business_name" text NOT NULL DEFAULT '',
  "website" text NOT NULL DEFAULT '',
  "practice_areas" text[] NOT NULL DEFAULT '{}'::text[],
  "service_area" text NOT NULL DEFAULT '',
  "services_offered" text NOT NULL DEFAULT '',
  "services_not_offered" text NOT NULL DEFAULT '',
  "competitors" text NOT NULL DEFAULT '',
  "protected_terms" text NOT NULL DEFAULT '',
  "notes" text NOT NULL DEFAULT '',
  "schedule_days" text[] NOT NULL DEFAULT '{}'::text[],
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_client_criteria_customer_uq"
  ON "google_ads_client_criteria" ("customer_id");

CREATE TABLE IF NOT EXISTS "google_ads_pacing_store" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "product" varchar NOT NULL DEFAULT 'gads',
  "monthly_budget" double precision,
  "mtd_spend" double precision,
  "pacing_pct" double precision,
  "recommended_daily" double precision,
  "expected_to_date" double precision,
  "generated_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_pacing_store_customer_product_uq"
  ON "google_ads_pacing_store" ("customer_id", "product");

CREATE TABLE IF NOT EXISTS "google_ads_traffic_quality" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "score" double precision NOT NULL,
  "window_days" integer NOT NULL DEFAULT 7,
  "analyzed_cost_dollars" double precision NOT NULL DEFAULT 0,
  "wasteful_cost_dollars" double precision NOT NULL DEFAULT 0,
  "captured_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_traffic_quality_customer_uq"
  ON "google_ads_traffic_quality" ("customer_id");

CREATE TABLE IF NOT EXISTS "google_ads_actioned_keywords" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "search_term" text NOT NULL,
  "action" varchar NOT NULL,
  "actioned_by_user_id" varchar,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_actioned_keywords_customer_term_uq"
  ON "google_ads_actioned_keywords" ("customer_id", "search_term");

CREATE TABLE IF NOT EXISTS "google_ads_account_alerts" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "product" varchar NOT NULL,
  "account_name" text,
  "alerts" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "digest_fingerprint" text,
  "generated_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_account_alerts_customer_product_uq"
  ON "google_ads_account_alerts" ("customer_id", "product");

CREATE TABLE IF NOT EXISTS "google_ads_audit_summaries" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" varchar NOT NULL,
  "product" varchar NOT NULL,
  "score" double precision,
  "band" varchar,
  "next_steps" jsonb,
  "audit_run_id" varchar,
  "generated_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_audit_summaries_customer_product_uq"
  ON "google_ads_audit_summaries" ("customer_id", "product");

CREATE TABLE IF NOT EXISTS "google_ads_client_log_summaries" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_name" text NOT NULL,
  "state" varchar NOT NULL,
  "entries" jsonb,
  "row_count" integer,
  "window_days" integer,
  "generated_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "google_ads_client_log_summaries_client_uq"
  ON "google_ads_client_log_summaries" ("client_name");
