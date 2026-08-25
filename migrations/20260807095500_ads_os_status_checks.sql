-- Ads OS — AM Dashboard (Task #3988): Paused/Off status-verification store.
-- Same two-column jsonb shape as the 0136 store tables. ONE document (key
-- 'all') holds the whole nightly batch: {"checks": {"{product}:{cid}": ...},
-- "generated_at": iso} — full overwrite per run, keep-last-batch guards in
-- statusCheck.ts decide whether a run may overwrite it.
-- Idempotent: IF NOT EXISTS, safe to re-run (also mirrored by the boot ensure
-- in storeSchema.ts).

CREATE TABLE IF NOT EXISTS ads_os_status_checks (
  key        TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
