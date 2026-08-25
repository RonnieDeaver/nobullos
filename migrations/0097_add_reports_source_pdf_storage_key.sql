-- Migration 0097 — saved-source-PDF storage key on reports (Task #2655).
--
-- Task #2652 added `sourcePdfStorageKey: text("source_pdf_storage_key")` to the
-- Drizzle model `shared/models/reports.ts` so "Re-parse from Source" keeps
-- working after the original (temporary Zapier S3) link expires, but it shipped
-- without the matching migration. The column was therefore absent from both the
-- dev and prod databases, so the deployed build's ORM SELECT on `reports`
-- (which includes that column) failed with `column "source_pdf_storage_key"
-- does not exist` (SQLSTATE 42703), 500-ing every reports query. This migration
-- creates the missing column.
--
-- Additive nullable column — publish-safe (no constraint to violate, no backfill
-- required; existing reports default to NULL = "no saved PDF copy", which the
-- re-parse path already handles by falling back to the original-link re-fetch
-- and, if that link is dead, a clear "upload manually" message).
ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS source_pdf_storage_key text;
