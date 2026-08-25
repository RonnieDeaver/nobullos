# Client File Storage — Operator Runbook

## Overview

In-app, Drive-style file storage for client files (Task #4023). Files live in the
app's private object storage bucket instead of the retired Google Drive mirror (Task #4084):

- **Per-client file spaces** — folder hierarchy, drag-drop multi-upload, list/grid
  views, search, previews, bulk move/trash/download.
- **Versioning** — uploading a file with the same name into the same folder keeps
  the old content as a prior version of the SAME file; any version is restorable.
- **Trash** — per-client trash with restore and permanent delete; a retention
  worker purges expired trash automatically (default OFF).
- **Activity log** — per-client feed of uploaded/renamed/moved/trashed/restored/
  purged/downloaded actions with denormalized actor names.
- **Global Files library** — cross-client search + recent files at `/files`, and a
  per-client storage-usage rollup for team leads.

- **External share links** (Task #4028) — per-file expiring links for people
  outside the app; token-gated, revocable, activity-logged.

Out of scope (follow-ups): in-app document editing, legacy-Drive
migration/cutover.

## Data model

`shared/models/clientFiles.ts`, migration `migrations/20260807173000_client_files.sql`:

| Table | Purpose |
| --- | --- |
| `client_file_folders` | Per-client folder tree (parent id, unique live name per parent). Cascades from `clients`. |
| `client_files` | Live file rows — name, mime, size, storage key, uploader, `folder_id` (SET NULL on folder delete), `trashed_at` state. |
| `client_file_versions` | Prior content of superseded/restored files — own storage key + `version_number`, cascades from the file. |
| `client_file_share_links` | External share links (Task #4028, migration `migrations/20260807194500_client_file_share_links.sql`) — `token_hash` (sha256 of the URL token; the raw token is never stored), `expires_at`, `revoked_at/by`, `access_count`. Cascades from the file. |
| `client_file_activity` | Per-client activity feed. `file_id` is nullable with ON DELETE CASCADE: a purged file's per-file rows vanish; the client-level `purged` tombstone (`file_id` NULL, detail `{name,sizeBytes,via}`) survives. `actor_name` is denormalized at write time. |

## Storage layout & claim security

Objects live in the private bucket under `client-files/<clientId>/<random>` —
minted per client by `POST /api/clients/:clientId/files/upload-url`
(`ObjectStorageService.getClientFileUploadURL`). The browser PUTs directly to the
presigned URL, then calls `claim`. Claim order (`server/routes/clientFiles.ts`):

1. **ACL read** — missing object → 400 "Uploaded object not found".
2. **Namespace gate** (`clientFileClaimAllowed`, `shared/clientFiles.ts`) — the
   object path must sit exactly one hex-shaped segment under
   `client-files/<thisClient>/`. Cross-client and nested-segment paths → 403; the
   object is NOT deleted (it may belong to someone else's pending flow).
3. **Content verification** (`generalUploadSniff.ts`) — empty objects and objects
   over `CLIENT_FILE_MAX_BYTES` (500 MiB) → 400 AND race-safe deletion of the
   rejected upload (`deleteRejectedUploadObject` with `expectedOwner` = claimant).
4. **ACL owner stamp** then DB rows inside one transaction.

Abandoned uploads (PUT but never claimed) are reaped by the Task #3983 sweep —
`client-files/` is a registered namespace prefix and live keys
(`client_files` + `client_file_versions` storage keys) are excluded as referenced
(see `WORKERS_QUEUES_RUNBOOK.md § Abandoned presigned-upload cleanup`).

## Downloads & previews

`GET .../:fileId/download` streams through the app (no direct bucket URLs; the
`/objects/...` ACL check rejects unauthenticated access). Headers come from the
DB mime — never storage metadata: `X-Content-Type-Options: nosniff`,
`Cache-Control: private, no-store`. `?inline=1` is honored ONLY for mimes on the
`INLINE_PREVIEW_MIMES` whitelist (images, PDF, video, audio, plain text/csv/json/
md). html/svg/xml are deliberately absent — storable but download-only, keeping
stored-XSS off the app origin. Bulk download: `POST .../zip` (fflate, total
budget `CLIENT_FILE_ZIP_MAX_TOTAL_BYTES` = 1 GiB).

## API surface

Per-client base `/api/clients/:clientId/files` — all routes `isAuthenticated` +
(account_manager+ role OR client owner), the save-plays authz pattern:

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/upload-url` | Mint presigned PUT in this client's namespace |
| POST | `/claim` | Claim an uploaded object (see order above); same name+folder supersedes into a version |
| GET | `/browse` `/search` `/trash` `/tree` `/usage` `/activity` | Listing surfaces |
| POST | `/folders` · PATCH/DELETE `/folders/:folderId` | Folder CRUD; delete trashes contained files (`{trashedFileCount}`); rename/move by body field; cycle guard → 400 `code:"cycle"` |
| POST | `/move` `/trash-files` `/restore` `/purge` `/empty-trash` `/zip` | Bulk file ops; restore returns to the original folder or root if it's gone |
| GET | `/:fileId` | Details: `{file, versions, activity}` |
| PATCH | `/:fileId` | Rename (live-name conflict → 409) |
| GET | `/:fileId/download` · `/:fileId/versions/:versionId/download` | Streaming download (current / prior version) |
| POST | `/:fileId/versions/:versionId/restore` | Swap current content with the version |

Global: `GET /api/files` (search) + `GET /api/files/recent` require
account_manager+; `GET /api/files/usage` (per-client + total storage rollup)
requires team_lead+.

## External share links (Task #4028)

Staff mint a link from the file details sheet (expiry choices 1/7/30/90 days,
default 7, cap `CLIENT_FILE_SHARE_MAX_DAYS`). The server generates a 256-bit
random token (`CLIENT_FILE_SHARE_TOKEN_BYTES`), returns it ONCE in the mint
response (the UI copies it to the clipboard), and stores only its sha256 in
`token_hash` — a DB leak never exposes working links, and old links cannot be
re-copied (mint a new one instead).

Public route `GET /share/file/:token` (no auth): shape-check
(`isShareTokenShaped`) → sha256 → exact-match lookup → gate
(`shareLinkStatus` active + file not trashed) → stream through the SAME
DB-derived-header path as staff downloads (nosniff, no-store, inline whitelist;
`?download=1` forces attachment). Never a raw bucket URL. Expired/revoked/
trashed → static 410 "Link expired" page; garbage/unknown → 404 page — both
pages contain zero user-controlled content. Each successful access bumps
`access_count` and logs a `downloaded` activity row with `via: "share_link"`
(actor "External share link").

| Method | Path | Notes |
| --- | --- | --- |
| POST | `.../:fileId/shares` | Mint (`{expiresInDays?}`) → `{share, token, path}`; trashed files 400 |
| GET | `.../:fileId/shares` | List all links (status derivable via `shareLinkStatus`); never exposes `token_hash` |
| DELETE | `.../:fileId/shares/:shareId` | Revoke (idempotent) |
| GET | `/share/file/:token` | PUBLIC download / gone page |

Mint/revoke are activity-logged as `shared` / `share_revoked`.

## Trash retention purge worker

`server/services/clientFileTrashPurge.ts`, seeded from
`server/boot/schedulerInits.ts` (stagger offset `client_file_trash_purge`),
cross-instance singleton lock `client_file_trash_purge`. Daily tick (override
`CLIENT_FILE_TRASH_PURGE_INTERVAL_MS`). **Objects first, rows second**: each
expired file's current + version objects are deleted before its DB rows; a
failed object delete retains the row so the next tick retries. Tombstone
activity actor: "Retention sweep".

| Knob (system_settings) | Default |
| --- | --- |
| `client_file_trash_purge_enabled` | **OFF** — deployment-gated; `CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE=1` bypasses locally (tests) |
| `client_file_trash_purge_retention_days` | 30 (cap 365) — cutoff on `trashed_at` |
| `client_file_trash_purge_max_files_per_tick` | 200 (cap 2000) |
| `client_file_trash_purge_last_run` | JSON summary of the last tick |

## UI surfaces

- **Client page → Files tab** (`?tab=files`, `client/src/components/clientFiles/ClientFilesTab.tsx`) — folder tree/breadcrumbs, drag-drop multi-upload with per-file progress, list/grid, previews, bulk actions, version history panel, trash view. Supports `?tab=files&file=<id>` deep links (opens the file's folder + details sheet) — used by communication-log and call-archive "File" links. The command panel's primary "Client Files" button lands here (Drive link demoted to legacy — Task #4025).
- **Global library** (`/files`, `client/src/pages/FilesLibrary.tsx`) — recent files, cross-client search with kind filter, storage-usage panel (team_lead+); quicklinks entry "Files".


## Pipeline delivery (Task #4025, Drive mirror retired by Task #4084)

New Zoom recordings and Twilio call recordings/transcripts are delivered into client folders (`Zoom Recordings`, `Call Recordings`, `Call Transcripts`) by `server/services/clientFileDelivery.ts` — unconditionally; in-app files are the only pipeline sink since the Google Drive integration was retired ([GOOGLE_DRIVE.md](./GOOGLE_DRIVE.md)). The Drive→in-app bulk import console shipped by Task #4025 was removed in the same retirement (it was never run in production).

## Verification

- `npm test -- --file=tests/client-files-routes.test.ts` — authz (including the
  auto-provisioned-sub default-role admission), claim gates (cross-namespace,
  nested segment, foreign owner, empty/oversize), versioning + restore, trash
  lifecycle, download headers, usage rollups, global roles, zip, activity feed.
- `npm test -- --file=tests/client-files-purge.test.ts` — purge disabled by
  default, objects-first purge with per-file failure isolation + retry.
- `npm test -- --file=tests/client-file-shares.test.ts` — share-link guardrails:
  mint authz, hash-only storage, valid token serves exactly the one file with
  no session, garbage/unknown/expired/revoked/trashed tokens rejected with the
  gone page, revoke idempotency, activity logging.
- `npm test -- --file=tests/client-file-delivery.test.ts` — folder-path
  provisioning, store/reuse/supersede, Zoom + call-archive delivery
  idempotency.
## Keywords / grep anchors

`clientFileClaimAllowed` · `client-files/` · `getClientFileUploadURL` ·
`verifyClientFileObjectContent` · `runClientFileTrashPurgeTick` ·
`client_file_trash_purge` · `INLINE_PREVIEW_MIMES` · `CLIENT_FILE_MAX_BYTES` ·
`shareLinkStatus` · `isShareTokenShaped` · `/share/file/` ·
`client_file_share_links` · `CLIENT_FILE_SHARE_MAX_DAYS`
