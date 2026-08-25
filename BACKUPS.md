# Daily App Backup — Operator Runbook

This document covers day-2 operations for the daily app-backup feature
shipped under Task #2657. It is the canonical reference for what is
captured, where it lives, retention, how to download, how to restore a
dump manually, and the on-demand run path.

---

## 1. What gets captured

Every run produces up to two artifacts in **private** Object Storage
under the `backups/` key prefix (`BACKUP_KEY_PREFIX` in
`server/replit_integrations/object_storage/objectStorage.ts`):

1. **Database dump** — a complete `pg_dump` of the production Postgres
   database (Neon `neondb`), produced with `--no-owner --no-acl
   --format=plain`, piped through gzip and streamed straight into
   `backups/<YYYY-MM-DD>/database-<runStamp>.sql.gz`. The dump reads
   prod over the **direct** connection string
   (`MIGRATION_CONNECTION_STRING`), never a pooled connection, so a long
   dump never holds an `api`/`worker` pool connection (DB Hold Rules).
   The DB password is passed via `PG*` libpq env vars, never argv.

2. **File manifest + incremental archive** — every Object Storage object
   (private `PRIVATE_OBJECT_DIR` contents and the public search paths) is
   enumerated into a dated, gzipped JSON manifest at
   `backups/<YYYY-MM-DD>/<runStamp>/file-manifest.json.gz`. Each entry
   records the object key, size, content-type, and generation/checksum.
   To honor "keep everything" without re-copying unchanged bytes daily,
   only **new or changed** object bytes are copied into
   `backups/files/<sha256(fullPath)>/<generation>`; each day's manifest
   references the archived copy. The `backups/` prefix is skipped during
   enumeration so backups never recurse into themselves.

Each run also writes an `app_backup_runs` bookkeeping row (see § 4) via
the **worker** DB pool.

---

## 2. Status semantics

A run is recorded with one of these statuses, and the admin page never
shows a non-success run as green:

| Status | Meaning |
| --- | --- |
| `in_progress` | The run is executing (or its holder crashed — see § 5). |
| `success` | Both the DB dump and the file manifest/archive completed. |
| `partial` | Exactly one half failed (DB ok but files failed, or vice-versa). The `errorMessage` names which half. |
| `failed` | Both halves failed. |

Any `partial` or `failed` run fires the `infra.backup.failed`
notification (see [NOTIFICATIONS.md](./NOTIFICATIONS.md)) so a silent
backup outage is caught. `errorMessage` (up to 4000 chars) carries the
failure reason and is surfaced on the admin page.

---

## 3. Where it runs (deployment-gated singleton)

- The scheduler (`server/services/appBackupScheduler.ts`) fires a
  `node-cron` job at **04:00 America/New_York** (`0 4 * * *`).
- It is **deployment-gated**: `startAppBackupScheduler` returns early
  unless `isRunningInDeployment()` (`REPLIT_DEPLOYMENT==="1"`). The dump
  targets prod, and the dev workspace can only *read* prod, so a
  workspace run would never produce a real production backup. **The job
  never runs in dev.**
- The cron fires on every autoscale instance, so the body takes a
  cluster-wide Postgres advisory lock via `acquireWorkerSingletonLock`
  (key `scheduler:app-backup`) so **exactly one** instance runs the
  backup. The lock self-heals (releases when the holder crashes) and has
  a `maxHoldMs` watchdog (`CROSS_INSTANCE_LOCK_MAX_HOLD_MS.app_backup` =
  120 min) so a hung run can't hold it forever.
- Stagger offset is registered in `WORKER_STAGGER_OFFSETS`
  (`workerConfig.ts`).

---

## 4. Backup-run records (`app_backup_runs`)

Source of truth the admin page reads. Defined in
`shared/models/backups.ts`, storage helpers in
`server/storage/backupRuns.ts`:

- `id`, `createdAt`, `finishedAt`
- `kind` (`scheduled` | `manual`), `triggeredBy` (user id for a manual
  press; null for the daily job)
- `status`, `dbStatus`, `filesStatus`
- `dbDumpKey`, `fileManifestKey`
- `dbDumpSizeBytes`, `fileObjectCount`, `fileCopiedCount`,
  `fileTotalSizeBytes`, `totalSizeBytes`
- `errorMessage`

Retention is **indefinite** — nothing is auto-deleted.

---

## 5. Stale-run recovery

A run whose holder crashes/recycles is left `in_progress`. Before each
scheduled pass, `storage.failStaleInProgressBackupRuns(STALE_RUN_MS)`
sweeps any run older than `maxHoldMs + 30 min` to `failed`, so the admin
page never shows a stuck run as success.

---

## 6. Admin page + API

Page: `/admin/backups` (`client/src/pages/admin/BackupsConsole.tsx`),
lazy-loaded and registered in `App.tsx`. **CEO-only** — both the page
(client-side `role==="ceo"`) and the API (`getAssignedAuthority(user)
=== "ceo"`, mirroring `prodActions`) gate access; non-CEOs get
Access Denied / HTTP 403.

| Route | Purpose |
| --- | --- |
| `GET /api/admin/backups` | List runs, newest first. |
| `POST /api/admin/backups/run` | "Run backup now" — runs synchronously through `runWithWorkerDb`, kind `manual`, `triggeredBy` = pressing user. |
| `GET /api/admin/backups/:id/download/db` | Stream the gzipped DB dump (`backup-<id>-database.sql.gz`). |
| `GET /api/admin/backups/:id/download/manifest` | Stream the gzipped file manifest (`backup-<id>-file-manifest.json.gz`). |

Downloads go through the authenticated private-object streaming gateway
(`getPrivateObjectFileByKey` + `downloadObject`) — never a public URL.

---

## 7. Restoring a database dump manually

Full automated restore is **out of scope** (a riskier follow-up). To
restore the downloaded dump manually, an operator runs:

```sh
gunzip -c backup-<id>-database.sql.gz | psql "<target-connection-string>"
```

The dump is plain SQL with `--no-owner --no-acl`, so it restores into
any database the operator has write access to without needing the
original role/ACLs. See https://www.postgresql.org/docs/16/app-pgdump.html.

To recover a single file from a given day, read that day's
`file-manifest.json.gz`, find the object's `archiveKey`, and download
`backups/files/<...>` from Object Storage.

### 7.1 Dev refresh: restore the newest prod dump into the DEV database (Task #4552)

Dev's database is a stale clone of prod, so reports in dev drift toward
missing/outdated data. One guarded command refreshes dev from the newest
prod backup dump:

```sh
# On the MAIN dev workspace (NOT a task environment),
# with the "Start application" workflow STOPPED:
npx tsx scripts/refresh-dev-db-from-backup.ts --confirm-refresh-dev
```

Expect ~5–10 minutes end-to-end at current prod size (2026-08: 713 MB
gzip → ~6.9 GB SQL, 245 tables; download ~15 s, apply ~4–6 min,
ANALYZE + sweep ~1 min).

What it does, in order:

1. Enumerates `backups/<date>/database-*.sql.gz` **directly in Object
   Storage** (never the `app_backup_runs` table — that table is itself
   stale dev data) and picks the newest dump. `--dump-key=backups/<date>/
   database-<stamp>.sql.gz` restores a specific older dump instead.
2. Downloads it to a temp file. Lingering DB backends are terminated and
   the tool **refuses to proceed** if anything reconnects (checked before
   the download AND again right before the drop) — a running dev app
   self-heals "missing" tables mid-restore and collides with the dump's
   `CREATE TABLE`, so stop the app workflow first.
3. Drops and recreates schema `public` — plus any schemas the dump itself
   creates (prod carries `_system` and `stripe`), which would otherwise
   abort the dump's own `CREATE SCHEMA` — then streams `gunzip → psql -v
   ON_ERROR_STOP=1` over the direct (non-pooled) connection with the
   password passed via `PG*` env vars (same convention as the producer). A
   partial apply exits non-zero — it can never masquerade as success.
4. Runs `ANALYZE`, prints tables restored + per-table row counts, and runs
   the **report-completeness sweep** (`scripts/verify-report-completeness.ts`,
   also runnable standalone). The sweep checks restore *fidelity* — prod
   writes report sections incrementally, so low section counts are normal:
   it fails on unknown section keys, orphaned sections, section-less
   *final* reports, missing tables, an empty `reports` table, and any
   `heatmapSnapshotId(s)` in section JSON that doesn't resolve to a real
   `heatmap_snapshots` row. Offenders are named; the command exits
   non-zero.
5. Flushes the shared Redis cache namespaces (`system_settings`,
   `integration_status`, `integration_status_epoch`) so stale pre-restore
   values aren't pinned or re-latched.

Safety guards (all refusals exit 3, loudly):

- Refuses to run in a deployment (`REPLIT_DEPLOYMENT=1`).
- Refuses any target on a Neon host or named `neondb` (prod); dev is
  Helium `heliumdb`. Unparseable connection strings are refused outright.
- Requires the explicit `--confirm-refresh-dev` flag.
- `--dump-key` only accepts real `database-*.sql.gz` keys — never a
  manifest or `backups/files/` archive object.

**Freshness:** the scheduled dump is written at 04:00 UTC daily. If you
need fresher-than-4am data, press **Run backup now** on `/admin/backups`
in prod first, wait for the run to finish, then run the refresh — the
same-day manual dump sorts newest and is picked automatically.

**After the restore (required):**

1. Restart the "Start application" workflow. First boot baselines the dev
   migration ledger (`_dev_applied_migrations` is absent in a prod dump),
   re-runs the boot-time ensure/self-heal for raw-SQL objects, and flushes
   the env cache namespaces again.
2. Migrations **merged since the last prod Publish** are initially
   baselined as already-applied (the prod dump lacks their DDL), but the
   boot-time ledger-drift detector notices their objects are missing,
   removes the ledger rows, and re-runs them automatically — observed
   re-applying 34 such migrations after the 2026-08-11 rehearsal restore.
   Residual gap: a migration whose absence leaves no detectable object
   signature (e.g. data-only INSERTs) stays baselined without executing.
   Apply such a file manually — `psql "$DATABASE_URL" -f
   server/migrations/<file>.sql` — or run the canonical post-merge
   convergence (`bash scripts/post-merge.sh`). If dev logs show
   `42703`/`42P01` errors after a refresh, this is why.
3. Spot-check a report in the dev UI; re-run
   `npx tsx scripts/verify-report-completeness.ts` any time for a
   read-only completeness verdict.

**Scope caveat:** run this on the **main dev workspace**. A task
environment run only refreshes that environment's private DB clone — it
does nothing for the shared dev database.

---

## 8. Config

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `PG_DUMP_PATH` | env var | no | Overrides the `pg_dump` binary path. Defaults to `pg_dump` on `PATH`. |

There is **no** `system_settings` kill switch — backups are gated
purely on `REPLIT_DEPLOYMENT`. This applies to **both** the scheduled
cron and the CEO-triggered on-demand run: `runAppBackup` refuses (no run
row created) when `REPLIT_DEPLOYMENT !== "1"`, and the on-demand route
returns `409`. A workspace run would dump the dev DB, not prod, since the
dev workspace can only read prod.

---

## 9. Future hardening (noted, not built)

- One-click full app restore.
- Off-Replit / off-site replication of the `backups/` prefix.
- Encryption-at-rest beyond what Object Storage already provides.
- UI-configurable retention (currently fixed at "keep everything").
