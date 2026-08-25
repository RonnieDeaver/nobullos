ALTER TABLE "webhook_import_logs" ADD COLUMN IF NOT EXISTS "pdf_source_url" text;
ALTER TABLE "webhook_import_logs" ADD COLUMN IF NOT EXISTS "webhook_payload" jsonb;
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "webhook_import_log_id" varchar;
