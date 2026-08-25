ALTER TABLE "client_semrush_integrations"
  ADD COLUMN IF NOT EXISTS "last_sync_outcome" text,
  ADD COLUMN IF NOT EXISTS "last_sync_summary" text;
