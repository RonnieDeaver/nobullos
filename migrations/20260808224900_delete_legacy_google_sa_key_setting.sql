-- Task #4107 — remove the stored legacy Google service-account key.
--
-- Task #4084 retired the Drive integration; the surviving Sheets read lane
-- (Ads OS client-log reader, spreadsheets.readonly) authenticates with the
-- dedicated GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY secret, which takes precedence
-- over this setting. The legacy key held Drive access (audit finding B-008);
-- the operator deletes it in Google Cloud Console and this migration removes
-- the stale stored copy so the app no longer carries the key material.
--
-- Ordering safety: this migration runs at Publish, and Publish also refreshes
-- the deployment's secret snapshot — so by the time the stored fallback is
-- gone in prod, GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY is guaranteed present in
-- the same deployment.
--
-- Idempotent (DELETE WHERE) — safe under post-merge.sh SAFE_MIGRATIONS
-- re-application and dev-ledger re-runs.

DELETE FROM system_settings WHERE key = 'google_service_account_key';
