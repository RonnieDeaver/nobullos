-- Task #3993 — partial index backing the reworked Front webhook
-- receiver-staleness watcher, which now keys on webhook-origin rows
-- only (dedupe_key LIKE 'front:webhook:%') instead of MAX(received_at)
-- over ALL source_system='front' rows (reconcile sweeps write ~575
-- rows/day, keeping that timestamp perpetually fresh and hiding a
-- receiver that has never worked). The watcher runs MAX(received_at)
-- over the webhook grain every 5 minutes; this index makes that an
-- index-only backward scan instead of a seq/filter over every Front row.
-- Idempotent: IF NOT EXISTS, safe to re-run.

CREATE INDEX IF NOT EXISTS sel_front_webhook_received_at_idx
  ON source_event_log (received_at DESC)
  WHERE dedupe_key LIKE 'front:webhook:%';
