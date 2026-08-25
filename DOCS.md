# NoBull Docs — Operator Runbook

## Overview

NoBull Docs is the in-app word processor built into NoBull OS (Univer docs preset), completing the office suite next to NoBull Sheets. It mirrors the Sheets persistence stack:

- **Document CRUD** — created from the Docs & Sheets library or a client's Files tab; full-page editor at `/docs/:id`.
- **Concurrent edit locking** — single active editor: TTL lock with heartbeat + optimistic revision guard prevents split-brain saves.
- **Version history** — auto-versioned on save (5-minute cadence gate) and manually on demand; any version is restorable, and every restore first captures an undoable restore point.
- **DOCX import** — upload a `.docx` (≤ 50 MB) and continue editing in-app.
- **DOCX export** — download any document back to `.docx`.
- **Client linkage** — documents may belong to a client; client-linked documents are readable by every account manager and surface in that client's Files tab.
- **Activity log** — created / renamed / edited (per lock session) / imported / exported / version_saved / restored, capped per document.

There is **no** docs-specific kill switch (deliberate — reuse of `sheetsAutosaveLimiter` covers autosave pressure; Sheets' `sheets_writes_disabled` does *not* affect docs).

---

## API Surface

All routes require `isAuthenticated` + `requireAccountManager` (account_manager or higher).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/docs/documents` | List documents visible to caller (`?clientId=` filters to one client) |
| POST | `/api/docs/documents` | Create document (optional initial `snapshot`, optional `clientId`) |
| GET | `/api/docs/documents/:id` | Get document with snapshot |
| PATCH | `/api/docs/documents/:id` | Rename / re-link client, or save snapshot (lock + `expectedRevision` required) |
| DELETE | `/api/docs/documents/:id` | Delete (owner or CEO only; versions/locks/activity cascade) |
| POST | `/api/docs/documents/:id/lock` | Acquire edit lock → `{ acquired, lock }` |
| POST | `/api/docs/documents/:id/lock/heartbeat` | Renew lock TTL → `{ lock }` or `409 LOCK_LOST` |
| DELETE | `/api/docs/documents/:id/lock` | Release own lock (idempotent; logs the edit session) |
| GET | `/api/docs/documents/:id/lock` | Poll lock state → `{ locked, lock? }` |
| GET | `/api/docs/documents/:id/versions` | List version history (metadata only, newest first) |
| GET | `/api/docs/documents/:id/versions/:vId` | Get one version with snapshot |
| POST | `/api/docs/documents/:id/versions` | Save manual version checkpoint `{ snapshot, label? }` |
| POST | `/api/docs/documents/:id/versions/:vId/restore` | Restore a version (restore point captured first, revision bumps) |
| GET | `/api/docs/documents/:id/activity` | Activity log (default 50, max 200 entries) |
| POST | `/api/docs/documents/import` | Multipart `.docx` upload → new document, returns `{ document, report }` |
| GET | `/api/docs/documents/:id/export/docx` | Download as `.docx` attachment |
| GET | `/api/docs/team-roster` | Minimal teammate list `{ users }` for the Share dialog picker (account_manager+) |
| GET | `/api/docs/documents/:id/permissions` | List per-user sharing grants (owner or CEO only) |
| PUT | `/api/docs/documents/:id/permissions` | Grant / update a user's access `{ userId, role: "viewer"\|"editor" }` (owner or CEO only) |
| DELETE | `/api/docs/documents/:id/permissions/:userId` | Revoke a grant (owner or CEO only; idempotent) |

**Access model:** CEO sees everything (owner-equivalent). Everyone else sees their own documents, **all client-linked documents** (team-shared by design, matching how client work is shared), plus documents shared with them via a per-user grant. Personal documents of another user without a grant → 403. Delete and grant management are owner-or-CEO only.

### Permission Model (Task #4053)

Per-user sharing grants (`doc_document_permissions`) mirror Sheets' workbook permissions, minus role-level grants and the "owner" grant level:

| Access level | Who has it | Can view | Can edit/save (holds lock) | Can manage sharing / delete |
| --- | --- | --- | --- | --- |
| owner | document creator, or any CEO | ✓ | ✓ | ✓ |
| editor | explicit grant, or any client-linked document | ✓ | ✓ | ✗ |
| viewer | explicit grant | ✓ | ✗ | ✗ |

Viewers open the document read-only: the client never acquires the edit lock for them, and every write path (`PATCH`, lock acquire, manual version, restore) returns 403 server-side. `GET /api/docs/documents/:id` includes a `userPermission` field ("owner" | "editor" | "viewer") so the client renders the right mode. Grant/revoke actions are recorded in the document activity log as `shared` / `unshared`.

---

## Edit Locking

Saving a snapshot requires the caller to hold the edit lock and supply `expectedRevision`.

**Flow (same contract as Sheets):**
1. `POST /lock { holderName }` → `{ acquired: true, lock }` or `{ acquired: false, lock }` (someone else holds it — editor opens read-only with an amber banner and polls).
2. Heartbeat every 30 s: `POST /lock/heartbeat` → `200 { lock }` or `409 LOCK_LOST`.
3. Save: `PATCH /:id { snapshot, expectedRevision }` → `200` (revision incremented) or `400 MISSING_REVISION` / `409 REVISION_CONFLICT` / `423 LOCK_REQUIRED`.
4. Release: `DELETE /lock` → `{ ok: true }` (also fires on tab close via `beforeunload`).

Lock TTL is 90 s; a crashed editor frees itself within that window. The lock is keyed by **user**, so a second tab of the same user shares the lock — the revision guard is what prevents those two tabs from clobbering each other.

**Restore bumps the revision** through the same guarded save, so any stale tab's next autosave gets `409` instead of silently undoing the restore.

---

## Version History

- **Auto-version:** captured on snapshot save if ≥ 5 minutes have passed since that document's last version.
- **Manual version:** `POST /:id/versions { snapshot, label? }` always captures.
- **Restore:** current state is saved as a restore point (`isRestorePoint: true`) first, then the target snapshot is applied via the revision-guarded save.
- **Retention thinning:** < 24 h keep all → daily granularity to 7 d → weekly to 30 d → deleted after 30 d (restore points follow the same schedule).

---

## DOCX Import / Export

**Import:** `POST /api/docs/documents/import` — multipart form: `file` (`.docx`, ≤ 50 MB), optional `name`, optional `clientId`. Conversion (fflate unzip + lazy jsdom XML parse) completes fully **before** the single DB insert (DB-hold rule). Responses: `201 { document, report }`, `400` missing file / unknown client, `413` file or converted snapshot too large, `415` non-docx, `422` unreadable file.

**What survives import (Task #4052):** tables import as real editable Univer tables (grid + `tableSource`; column spans kept), and embedded pictures (PNG/JPEG/GIF/BMP referenced via `a:blip`) import as inline BASE64 image drawings that render in the editor and re-export. Title/Subtitle/Heading 1–5, bold/italic/underline/strikethrough, font size/color, alignment, and lists survive as before.

**Known import limitations (by design — only genuinely unsupported constructs land in `report.entries`):**
- Non-picture drawings (shapes, charts) and legacy VML `w:pict`/`w:object` are skipped (`image_skipped` entry; `imagesSkipped` count — `imagesImported` counts successes).
- Vertically merged table cells import as separate cells; nested tables flatten into the parent cell (both get an `unsupported` entry).
- Headers/footers/footnotes/comments are dropped; hyperlinks keep text but lose the target.

**Export:** `GET /:id/export/docx` streams a `.docx` attachment (docx npm package). Any reader may export; `422` when the document has no content yet. Headings, basic run styling, alignment, lists, tables, and BASE64 images round-trip; the Subtitle named style exists in the converter but has no editor UI affordance yet (latent).

---

## Editor Surface (client)

- `client/src/pages/DocEditor.tsx` — full-page editor: lock acquire → 30 s heartbeat → 10 s lock poll when locked; 1.5 s debounced autosave armed by Univer `doc.mutation.*` commands (DOM listeners never see typing — the docs engine uses a hidden body-level input); version sidebar with preview/restore; activity sidebar; Save version; Download `.docx`; mobile (< 768 px) warning. Read-only mode auto-reverts local mutations (docs preset has no native read-only API).
- `client/src/components/docs/UniverDocEditor.tsx` — the **only** place `@univerjs/preset-docs-*` may be imported (dynamic `await import()`), mirroring `sheets/UniverEditor.tsx`. Bundle isolation is lint-enforced (`scripts/lint-bundle-budget.ts` allows `@univerjs` only in chunks shared with `components/sheets/` or `components/docs/`).
- `client/src/components/docs/DocumentsSection.tsx` — reusable library section (create / upload / rename / download / delete), mounted in the Docs & Sheets library and in each client's Files tab (`clientId` prop).

---

## Storage & Data Model

Tables (see `shared/models/docs.ts`, migration `20260807193500_nobull_docs_tables.sql`):

| Table | Purpose |
| --- | --- |
| `doc_documents` | Snapshot (JSONB), `revision` counter, owner, optional `client_id`, size bookkeeping |
| `doc_document_locks` | One row per document; holder, `expires_at` (90 s TTL), heartbeat timestamp |
| `doc_document_versions` | Version snapshots; `is_restore_point`, optional label, size, retention-thinned |
| `doc_document_activity` | Capped per-document audit trail |

Server modules: `server/routes/docs.ts`, `server/storage/docsStorage.ts` (all queries pool-attributed `docs:*`), `server/services/docsImportConverter.ts`, `server/services/docsExportConverter.ts`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Someone else is editing" banner but nobody is | Holder crashed < 90 s ago | Wait for TTL expiry; the poll reclaims automatically |
| Saves failing with 409 | Second tab / restored elsewhere | Reload the editor (banner offers it) — never hand-edit `revision` |
| Import returns 422 | Corrupt or non-OOXML file | Re-export from the source app as `.docx` (not `.doc`) |
| Imported doc missing a drawing/shape | Non-picture drawings unsupported by design | See report toast at import time; re-add content in-app |
| Editor blank on `/docs/:id` | Snapshot `null` (new doc) boots a blank page — if truly stuck, check browser console for Univer preset chunk load failures | Hard-refresh; verify `/api/docs/documents/:id` returns 200 |

Tests: `tests/docs-routes.test.ts`, `tests/docs-versions.test.ts`, `tests/docs-import-export.test.ts` (all smoke-gated).
