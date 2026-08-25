-- Task #4537 — operator-set "Presented / Delivered" tracking on monthly
-- reports (RERs). status="final" only means finalized internally; these
-- columns record that the report was actually presented or delivered to the
-- client, and by whom. Stamped server-side via storage.setReportPresented
-- (the only writer); both NULL = never presented. Purely additive and
-- idempotent — no backfill (NULL is the correct historical state for every
-- existing report), no destructive statements.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS presented_at timestamp;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS presented_by varchar REFERENCES users(id);
