-- Task #4811 — re-anchor the open-ask duplicate backstop in the schema
-- (completion of the Task #4765 / #4803 staged constraint rollout).
--
-- History: 20260814125621_open_ask_dedup_hindsight.sql built
-- client_open_asks_active_summary_uniq in dev, but production still held
-- pre-existing duplicate active rows, so Publish's schema-only validation
-- could not create the index there (Publish moves structure, never data
-- cleanup). 20260814195541 dropped the index in dev (and the model entry
-- was removed) to unblock Publish, and the enable_open_ask_dedup_constraint
-- prod action performed the data-dependent half in production on
-- 2026-08-14: merged 8 duplicate twins into their oldest keepers with
-- audited notes, then built this same index (verified live afterwards:
-- index present, 0 duplicate active groups).
--
-- This migration closes the dev/prod drift window by re-creating the index
-- wherever it is still missing — dev when this merges; hermetic/genesis
-- test DBs get it from the restored model entry in
-- shared/models/dailyJudgment.ts. Idempotent: IF NOT EXISTS makes it a
-- no-op replay in production and in any environment the prod action
-- already enabled. DDL matches 20260814125621 and the action verbatim.
-- If a pathological environment still holds duplicate active rows, this
-- CREATE fails loudly at boot and the still-registered
-- enable_open_ask_dedup_constraint action is the sanctioned repair.

CREATE UNIQUE INDEX IF NOT EXISTS client_open_asks_active_summary_uniq
  ON client_open_asks (client_id, md5(lower(btrim(summary))))
  WHERE status IN ('open', 'likely_open', 'likely_resolved');
