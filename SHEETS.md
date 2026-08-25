# NoBull Sheets — Operator Runbook

## Overview

NoBull Sheets is a collaborative workbook tool built into NoBull OS. It supports:

- **Folder + workbook CRUD** — organize workbooks into folders; owner-only folder management.
- **Concurrent edit locking** — optimistic-lock with heartbeat + revision guard prevents split-brain saves.
- **Version history** — auto-versioned on save (5-minute cadence gate) and manually on demand; any version is restorable.
- **Live data blocks** — refreshable connectors (report metrics, Google Ads spend, Front coverage, SEMrush keywords) inserted into sheet cells.
- **XLSX / CSV import** — file upload (the Google Drive import path was retired with the Drive integration, Task #4084).
- **XLSX / CSV export** — whole-workbook xlsx or single-sheet csv download.
- **Permission model** — per-user (viewer / editor) and per-role grants; owner + CEO always have write access.
- **Kill switch** — `sheets_writes_disabled` halts all write paths instantly, leaving reads unaffected.

---

## API Surface

All routes require `isAuthenticated` + `requireAccountManager` (account_manager or higher).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/sheets/folders` | List caller's folders |
| POST | `/api/sheets/folders` | Create folder |
| PATCH | `/api/sheets/folders/:id` | Rename folder (owner only) |
| DELETE | `/api/sheets/folders/:id` | Delete folder (owner only) |
| GET | `/api/sheets/workbooks` | List workbooks accessible to caller |
| POST | `/api/sheets/workbooks` | Create workbook |
| GET | `/api/sheets/workbooks/:id` | Get workbook with snapshot + `userPermission` |
| PATCH | `/api/sheets/workbooks/:id` | Update name/folder, or save snapshot (lock + revision required) |
| DELETE | `/api/sheets/workbooks/:id` | Delete workbook (owner or CEO only; versions cascade) |
| POST | `/api/sheets/workbooks/:id/lock` | Acquire edit lock |
| POST | `/api/sheets/workbooks/:id/lock/heartbeat` | Renew lock TTL |
| DELETE | `/api/sheets/workbooks/:id/lock` | Release lock |
| GET | `/api/sheets/workbooks/:id/lock` | Poll lock state |
| GET | `/api/sheets/workbooks/:id/permissions` | List user permissions (owner or CEO only) |
| PUT | `/api/sheets/workbooks/:id/permissions` | Grant / update a user permission |
| DELETE | `/api/sheets/workbooks/:id/permissions/:userId` | Revoke a user permission |
| GET | `/api/sheets/workbooks/:id/role-grants` | List role-level grants (owner or CEO only) |
| PUT | `/api/sheets/workbooks/:id/role-grants` | Upsert role-level grant |
| DELETE | `/api/sheets/workbooks/:id/role-grants/:role` | Remove role-level grant |
| POST | `/api/sheets/workbooks/import` | Multipart xlsx/csv upload → new workbook |
| GET | `/api/sheets/drive/sheets` | List Drive sheets accessible to service account |
| GET | `/api/sheets/workbooks/:id/export/xlsx` | Download workbook as xlsx |
| GET | `/api/sheets/workbooks/:id/sheets/:sheetId/export/csv` | Download sheet tab as csv |
| GET | `/api/sheets/workbooks/:id/versions` | List version history (metadata only) |
| GET | `/api/sheets/workbooks/:id/versions/:vId` | Get specific version with snapshot |
| POST | `/api/sheets/workbooks/:id/versions` | Save manual version checkpoint |
| POST | `/api/sheets/workbooks/:id/versions/:vId/restore` | Restore to a version (current state auto-versioned first) |
| GET | `/api/sheets/connectors` | List available data-block connectors |
| GET | `/api/sheets/workbooks/:id/blocks` | List data blocks |
| POST | `/api/sheets/workbooks/:id/blocks` | Insert data block (enqueues immediate refresh) |
| DELETE | `/api/sheets/workbooks/:id/blocks/:blockId` | Remove data block |
| GET | `/api/sheets/workbooks/:id/activity` | List activity log (default 50, max 200 entries) |
| GET | `/api/sheets/workbooks/last-activity` | Bulk last-activity timestamps for a set of IDs |

---

## Edit Locking

Saving a snapshot requires the caller to hold the edit lock and supply `expectedRevision`.

**Flow:**
1. `POST /lock { holderName }` → `{ acquired: true, lock }` or `{ acquired: false, lock }` (another user holds it).
2. Heartbeat every 30 s: `POST /lock/heartbeat` → `200 { lock }` (still held) or `409 LOCK_LOST`.
3. Save: `PATCH /:id { snapshot, expectedRevision }` → `200` (saved, revision incremented) or `409 REVISION_CONFLICT` (stale revision) or `423 LOCK_REQUIRED` (caller doesn't hold lock).
4. Release: `DELETE /lock` → `200 { ok: true }`.

If a holder goes offline, the lock expires after its TTL and the next `POST /lock` reclaims it.

**Revision guard:** `expectedRevision` must equal the workbook's stored `revision`. On success the server atomically increments revision, making the old `expectedRevision` stale for any concurrent writer.

---

## Version History

- **Auto-version:** captured on every snapshot save if ≥ 5 minutes have elapsed since the last version for that workbook.
- **Manual version:** `POST /:id/versions { snapshot, label? }` always captures regardless of cadence.
- **Restore:** `POST /:id/versions/:vId/restore` versions the current state first (preserving undo), then applies the target snapshot. The restored workbook gets a fresh revision so subsequent saves work.
- **Retention thinning:** older versions beyond the configured threshold are pruned by the storage layer.

---

## Data Block Connectors

Connectors expose live NoBull data as refreshable cell ranges:

| Connector ID | Label |
| --- | --- |
| `report_metrics` | Report Metrics |
| `google_ads_spend` | Google Ads Spend |
| `front_coverage` | Front Coverage |
| `semrush_keywords` | SEMrush Keywords |

Role filtering applies: `ceo` sees all clients; `account_manager` sees only owned clients; other roles get empty results.

When a block is created, an immediate refresh job is enqueued on `sheet_data_block_refresh` (worker queue). Auto-refresh (if enabled) schedules periodic re-fetches.

---

## Import / Export

**Import (file upload):**
- `POST /api/sheets/workbooks/import` — multipart form: `file` (.xlsx/.xls/.csv/.tsv, ≤ 10 MB), optional `name`, optional `folderId`.
- Conversion runs fully before any DB write (DB-hold rule). Returns `{ workbook, report }` with a per-sheet skip summary.
- 413 if converted snapshot exceeds 10 MB; 415 for unsupported format; 422 for malformed file.

**Export:**
- Xlsx: `GET /:id/export/xlsx` — streams xlsx bytes; `Content-Disposition: attachment; filename="…"`.
- CSV: `GET /:id/sheets/:sheetId/export/csv` — streams UTF-8 csv for one sheet tab.
- Both require view-level access; no lock required.

---

## Permission Model

| Access level | Who has it | Can view | Can save snapshot | Can manage permissions |
| --- | --- | --- | --- | --- |
| owner | creator of the workbook | ✓ | ✓ | ✓ |
| editor | explicit grant or editor role-grant | ✓ | ✓ | ✗ |
| viewer | explicit grant or viewer role-grant | ✓ | ✗ | ✗ |
| CEO | any `ceo` role user | ✓ | ✓ | ✓ |

Role-level grants (`/role-grants`) grant access to all users of a given system role without per-user assignment.

---

## Kill Switch

| Kill switch | Key in `system_settings` | Default | Effect |
| --- | --- | --- | --- |
| Sheets writes disabled | `kill_switch_sheets_writes_disabled` | off (writes enabled) | All write endpoints return **503 SHEETS_WRITES_DISABLED**. Read-only paths (list, get, lock poll, connector list, block list, export) are unaffected. |

To enable during an incident: set `kill_switch_sheets_writes_disabled = true` in `system_settings`.  
To restore: set to `false` (or delete the row). The kill switch is cached with a short TTL; propagation across autoscale instances takes up to the cache TTL.

---

## DB-Hold Rules

- Import: conversion runs **before** the DB write. The hold contains only the single INSERT.
- Snapshot save: snapshot bytes are computed outside the hold; `saveSheetWorkbookSnapshot` is the only hold-bound call.
- Auto-versioning (`captureAutoVersion`) is fire-and-forget: it does not extend the snapshot-save hold.
- Data block enqueue runs after the block INSERT, outside any hold.

---

## Runbook Checklist

**Workbooks stuck in 423 LOCK_REQUIRED (editor can't save):**
1. Check `GET /api/sheets/workbooks/:id/lock` — identify the lock holder.
2. If the holder is offline / stale, wait for the TTL to expire, or release via a direct DB delete on `sheet_workbook_locks` where `workbook_id = :id`.
3. The next `POST /lock` from any editor reclaims it.

**Import failing with 422 "The file could not be converted":**
- Re-open the file in Excel/LibreOffice, re-save as `.xlsx`, retry.
- CSV: check for non-UTF-8 encoding (BOM, Latin-1). Convert to UTF-8 first.

**Data block not refreshing:**
- Check the `sheet_data_block_refresh` work queue entry: `SELECT * FROM work_queue WHERE type = 'sheet_data_block_refresh' ORDER BY created_at DESC LIMIT 5;`.
- If the queue is paused, unpause via the Admin → Workers panel or `system_settings.queue_drain_state`.

**Sheets writes kill switch stuck on:**
- `UPDATE system_settings SET value = 'false', updated_at = NOW() WHERE key = 'kill_switch_sheets_writes_disabled';`
- Allow one cache-TTL interval for autoscale instances to pick up the change.
