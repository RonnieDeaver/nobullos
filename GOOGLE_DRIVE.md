# Google Drive

> **RETIRED (Task #4084, 2026-08-08).** The Google Drive integration was
> removed end-to-end by operator decision (audit finding B-008 — the service
> account held the full `drive` scope, so a leaked key could reach every
> shared file). The pipeline now stores files **in-app only**
> ([CLIENT_FILES.md](./CLIENT_FILES.md)). This document is the retirement
> record plus the one surviving lane: the service-account **Sheets read
> lane**.

## What was removed

- **Drive mirror** — Zoom recordings and Twilio call recordings/transcripts
  are no longer copied to Drive (`clientFileDelivery.ts` and
  `callArchivePipeline.ts` write only to in-app client files; the
  `client_file_delivery_mode` lever is gone — delivery is unconditional).
- **Folder crawler + cache** — `googleDriveSyncWorker`, the
  `google_drive_folder_cache` table, its staleness watcher/alert, and the
  `google_drive_sync` queue lane/kill switch.
- **Drive → in-app bulk import console** (`/admin/drive-import`, Task #4025)
  and its `drive_import_runs` / `drive_import_items` / `drive_imported_files`
  tables — deleted before it was ever run in production.
- **Admin surfaces** — the Integrations Hub Drive card/status badge, folder
  pickers (command panel + Twilio unmatched-folder field), the Sheets
  "import from Drive" path, and all `/api/integrations/google-drive/*`,
  `/api/admin/drive-import/*`, `/api/sheets/*drive*` routes (20 routes).
- **Settings/state** — migration `20260808204207_retire_google_drive_integration.sql`
  drops the four Drive tables and deletes the retired settings keys (scope
  lever, delivery-mode lever, unmatched-folder ids, kill switches, staleness
  knobs) plus live notification state for the two retired alert ids.
- **Step 0 hardening from the migration plan** (config snapshot, zoom-mirror
  failure alert, `google_drive_token_scope` lever) shipped first and was then
  retired along with the integration it guarded.

## What survives — the Sheets read lane

`server/services/googleDriveIntegration.ts` now mints **only**
`spreadsheets.readonly` tokens:

- `getSheetsAccessToken()` — used by the Ads OS client-log reader to read
  Google Sheets. It resolves only
  `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY`; the retired
  `GOOGLE_SERVICE_ACCOUNT_KEY` and
  `system_settings.google_service_account_key` fallbacks are deliberately
  unavailable to the Sheets lane.
- `getSheetsServiceAccountEmail()` / `getServiceAccountEmail()` — surface the
  SA email for sheet-sharing instructions.
- A thrown settings read surfaces as `GoogleDriveSettingsUnavailableError`
  (config error, **never** an integration-disconnect signal).

There is no Drive scope anywhere in the codebase; no code path can mint a
Drive-scoped token.

## Legacy data (deliberately untouched)

- The team's existing Drive files stay where they are — nothing was deleted
  or moved in Drive.
- Old records keep display-only Drive links (`commandPanels.googleDriveFolderLink`,
  `google_drive_file_url` on historical communication rows). They render as
  plain external links and keep working as long as the files exist in Drive.

## Operator follow-through (closes B-008 for real)

Status as of Task #4107 (2026-08-08):

1. ✅ `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY` is set as a workspace secret and the
   Sheets lane mints tokens with it (verified: SA
   `393061781202-compute@developer.gserviceaccount.com`). Publishing refreshes
   the deployment's secret snapshot so the prod deployment carries it from the
   next Publish onward.
2. ✅ Stale in-app copies removed: `GOOGLE_SERVICE_ACCOUNT_KEY` never existed
   as an env var/secret, and migration
   `20260808224900_delete_legacy_google_sa_key_setting.sql` deletes the
   `google_service_account_key` system setting (dev already applied; prod at
   next Publish).
3. ⏳ **Press the CEO panel button** — CEO panel → Admin → Prod Actions →
   "Delete legacy Google Drive service-account key (B-008 closure)". The
   button:
   - verifies the Sheets lane is healthy before touching anything,
   - calls the Google Cloud IAM API to delete key `43d3ab85…` on SA
     `nobull-os@core-respect-369420.iam.gserviceaccount.com` (project
     `core-respect-369420`),
   - follows the DELETE with an IAM GET and requires a 404 before treating
     deletion as verified,
   - only after verified IAM absence, clears and re-reads the
     `google_service_account_key` DB setting (belt-and-braces),
   - re-verifies the Sheets lane is still healthy after deletion.

   If the API call returns 403 (insufficient IAM permissions), B-008 remains
   open and the DB setting is preserved. With explicit owner/security
   approval, the preferred remediation is owner-admin deletion in Google
   Cloud Console: IAM & Admin → Service Accounts → `nobull-os@…` → Keys →
   delete key `43d3ab85b5596ea3e8f822b4e5c007b47b7eb8de`.
   If an automated retry is approved instead, grant the Sheets service
   account a **resource-scoped custom role** on the target service account
   containing only `iam.serviceAccountKeys.delete` and
   `iam.serviceAccountKeys.get`. Do not grant key-create permission or the
   predefined Service Account Key Admin role: that broader role could mint
   a replacement credential for the legacy full-Drive identity. Revoke the
   custom grant after the lever verifies closure. The lever remains visible
   until its IAM probe verifies the key is gone.

   Task #4762 — this button is a **manual lever**: its status always reads
   `not-needed` (a lever is availability, not work — the old perpetual
   "Pending" held the CEO badge hostage behind an IAM probe that can fail
   from the app). The remaining-closure facts (DB setting / env var /
   GCP-side key state, with the classified reason when the IAM probe can't
   verify — 403 + console path, dead clone credentials, etc.) live in the
   lever's detail line. Once closure is *verified* (IAM probe sees 404, DB
   setting cleared, env var absent) the lever's served-purpose probe
   retires it to the panel's History with a completion note; "unknown"
   never retires it.
4. Optionally unshare the old Drive folders from
   `nobull-os@core-respect-369420.iam.gserviceaccount.com` — after key
   deletion this is belt-and-braces.

## History

- `audits/drive-least-privilege-migration-plan.md` — the Task #1592 design
  this retirement executed (end-state D, taken to full removal).
- `audits/drive-config-snapshot-2026-08-08.md` — pre-retirement config
  snapshot (prod had one linked client folder; unmatched mirror never
  configured).
- `audits/B-third-party-findings.md` § B-008 — the originating finding.

## Related runbooks

- [CLIENT_FILES.md](./CLIENT_FILES.md) — the in-app storage that replaced Drive.
- [TWILIO_RECORDING_ARCHIVE.md](./TWILIO_RECORDING_ARCHIVE.md) — call archive pipeline (in-app sink).
- [SHEETS.md](./SHEETS.md) — spreadsheet feature (file-upload import only).
- [GOOGLE_CALENDAR.md](./GOOGLE_CALENDAR.md) — the other Google integration (per-AM OAuth).
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.
