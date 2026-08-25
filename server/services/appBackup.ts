// @db-pool-intent: worker
//
// Task #2657 — daily app-backup producer. Two artifacts per run:
//
//   1. A complete PostgreSQL dump of the production database, produced with
//      `pg_dump` (plain SQL, restorable via `gunzip -c <dump> | psql <db>` —
//      see https://www.postgresql.org/docs/16/app-pgdump.html), piped through
//      gzip and streamed straight into private Object Storage. The dump reads
//      prod over the DIRECT connection string (`MIGRATION_CONNECTION_STRING`),
//      never the pooled API/worker pools, so a long dump never holds a pooled
//      connection (DB Hold Rules).
//   2. A dated file MANIFEST listing every Object Storage object plus an
//      incremental archive copy of any new/changed bytes (see Step 3). Uses
//      @google-cloud/storage File streaming / server-side copy
//      (https://googleapis.dev/nodejs/storage/latest/File.html).
//
// All bookkeeping (the `app_backup_runs` row) is written via the worker pool
// (`runWithWorkerDb` + the storage helpers, which use `withDbAttribution`).
// The producer itself is invoked from a `runWithWorkerDb` scope by both the
// scheduler and the on-demand admin route.

import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { MIGRATION_CONNECTION_STRING } from "../db";
import { storage } from "../storage";
import {
  ObjectStorageService,
  BACKUP_KEY_PREFIX,
  type BackupSourceObject,
} from "../replit_integrations/object_storage";
import { workerLog } from "./workerLogger";
import { notifyByType } from "./notifications/dispatcher";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import type { AppBackupKind, AppBackupRun } from "@shared/schema";

// Thrown when a backup is requested outside the deployment. The dump targets
// prod and the dev workspace can only READ prod, so a workspace run would
// dump the wrong (dev) database — never a real production backup. Both the
// scheduler and the on-demand admin route must honor this invariant.
export class BackupNotInDeploymentError extends Error {
  constructor() {
    super(
      "App backup can only run in the deployment (REPLIT_DEPLOYMENT=1) — the dev workspace can only read prod.",
    );
    this.name = "BackupNotInDeploymentError";
  }
}

// Resolved at call time (not module load) so the binary is overridable in
// tests, which set PG_DUMP_PATH after importing this module.
const pgDumpBin = () => process.env.PG_DUMP_PATH || "pg_dump";

export interface RunAppBackupOptions {
  kind: AppBackupKind;
  // The user id for a manual ("Run backup now") press; null/undefined for the
  // scheduled daily job.
  triggeredBy?: string | null;
}

export interface RunAppBackupResult {
  runId: string;
  status: AppBackupRun["status"];
}

/**
 * Test-only injection seam. Production call sites (the scheduler and the
 * on-demand admin route) pass nothing, so the defaults — the real
 * `ObjectStorageService` and `emitBackupFailure` — are used. Tests inject a
 * fake Object Storage (e.g. one whose copy always fails) and a no-op failure
 * emitter so the unit test never touches real storage or fires notifications.
 */
export interface RunAppBackupDeps {
  objectStorage?: ObjectStorageService;
  emitFailure?: (
    status: "failed" | "partial",
    kind: AppBackupKind,
    errorSummary: string,
  ) => Promise<void>;
}

// Build a libpq env (PGHOST/PGUSER/...) from the connection string so the
// password never appears in the child process argv (visible via `ps`).
// Exported for scripts/refresh-dev-db-from-backup.ts (Task #4552), which
// applies these dumps back onto the DEV database with the same convention.
export function pgEnvFromConnString(connString: string): NodeJS.ProcessEnv {
  const url = new URL(connString);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (url.hostname) env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const dbName = url.pathname.replace(/^\//, "");
  if (dbName) env.PGDATABASE = dbName;
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) {
    env.PGSSLMODE = sslmode;
  } else if (url.hostname && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    // Neon (deployed prod) requires TLS; default to require for remote hosts.
    env.PGSSLMODE = "require";
  }
  return env;
}

// Stream a gzipped pg_dump straight into the given private object key.
// Resolves with the stored size; rejects if pg_dump exits non-zero or the
// upload fails. No DB-pool connection is held for the duration.
async function streamDatabaseDump(
  objectStorage: ObjectStorageService,
  objectKey: string,
): Promise<{ sizeBytes: number | null }> {
  const env = pgEnvFromConnString(MIGRATION_CONNECTION_STRING);
  const child = spawn(
    pgDumpBin(),
    ["--no-owner", "--no-acl", "--format=plain"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8000) stderr += chunk.toString();
  });

  const gzip = createGzip();
  // If pg_dump dies, tear down the gzip pipe so the upload promise rejects.
  child.on("error", (err) => gzip.destroy(err));
  child.stdout.pipe(gzip);

  // Surface a non-zero pg_dump exit as an error on the gzip stream so the
  // upload's awaited promise rejects with a meaningful message.
  const exitPromise = new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = `pg_dump exited with code ${code}: ${stderr.trim().slice(0, 2000)}`;
        gzip.destroy(new Error(msg));
        reject(new Error(msg));
      }
    });
  });

  const uploadPromise = objectStorage.streamUploadToPrivateKey(
    objectKey,
    gzip,
    "application/gzip",
  );

  const [uploadResult] = await Promise.all([uploadPromise, exitPromise]);
  return { sizeBytes: uploadResult.size };
}

// Enumerate Object Storage, incrementally archive new/changed bytes, and
// write a dated gzipped JSON manifest. Returns counts + the manifest key.
async function backupFiles(
  objectStorage: ObjectStorageService,
  datePrefix: string,
  runId: string,
): Promise<{
  manifestKey: string;
  objectCount: number;
  copiedCount: number;
  failedCount: number;
  failedSamples: string[];
  totalSizeBytes: number;
}> {
  const sources = await objectStorage.listBackupSourceObjects();
  let copiedCount = 0;
  let failedCount = 0;
  const failedSamples: string[] = [];
  let totalSizeBytes = 0;

  const entries: Array<{
    sourcePath: string;
    archiveKey: string;
    sizeBytes: number | null;
    contentType: string | null;
    md5Hash: string | null;
    generation: string | null;
    updated: string | null;
  }> = [];

  for (const src of sources) {
    if (typeof src.sizeBytes === "number") totalSizeBytes += src.sizeBytes;
    // Deterministic, collision-free archive key: hash the source identity and
    // stamp the generation so an unchanged object (same generation) maps to
    // the same key across days and is never re-copied.
    const idHash = createHash("sha256").update(src.fullPath).digest("hex");
    const gen = src.generation || "nogen";
    const archiveKey = `${BACKUP_KEY_PREFIX}files/${idHash}/${gen}`;
    try {
      const { copied } = await objectStorage.copyObjectToBackupArchive(src, archiveKey);
      if (copied) copiedCount += 1;
    } catch (err: any) {
      // A single failed copy must not abort the whole manifest — record it
      // and continue so the manifest still captures every object's metadata.
      // BUT a copy failure means the archive is incomplete, so it MUST count
      // against the run's status (the caller marks the files half failed) —
      // never let a missing archive copy be reported as a clean success.
      failedCount += 1;
      if (failedSamples.length < 10) {
        failedSamples.push(`${src.fullPath}: ${err?.message ?? String(err)}`.slice(0, 200));
      }
      workerLog({
        worker: "app_backup",
        event: "app_backup_file_copy_failed",
        detail: `${src.fullPath}: ${err?.message ?? String(err)}`.slice(0, 500),
      });
    }
    entries.push({
      sourcePath: src.fullPath,
      archiveKey,
      sizeBytes: src.sizeBytes,
      contentType: src.contentType,
      md5Hash: src.md5Hash,
      generation: src.generation,
      updated: src.updated,
    });
  }

  const manifest = {
    runId,
    date: datePrefix,
    generatedAt: new Date().toISOString(),
    objectCount: entries.length,
    copiedThisRun: copiedCount,
    failedThisRun: failedCount,
    totalSizeBytes,
    objects: entries,
  };
  const manifestKey = `${BACKUP_KEY_PREFIX}${datePrefix}/file-manifest.json.gz`;
  const gzipped = gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"));
  await objectStorage.streamUploadToPrivateKey(
    manifestKey,
    Readable.from(gzipped),
    "application/gzip",
  );

  return {
    manifestKey,
    objectCount: entries.length,
    copiedCount,
    failedCount,
    failedSamples,
    totalSizeBytes,
  };
}

/**
 * Task #2657 — run a complete app backup (database + files). Creates an
 * `app_backup_runs` row up front (status `in_progress`), runs both halves
 * independently so one failing leaves the other recorded, then finalizes the
 * row to `success` / `partial` / `failed`. On any failure (full or partial)
 * fires `infra.backup.failed` so a silent backup outage is caught.
 */
export async function runAppBackup(
  opts: RunAppBackupOptions,
  deps: RunAppBackupDeps = {},
): Promise<RunAppBackupResult> {
  // Deployment-gate the producer itself so the invariant holds globally — for
  // both the scheduled cron AND the on-demand "Run backup now" admin button.
  // A workspace run would dump the dev DB, not prod, so we refuse before
  // creating any run row.
  if (!isRunningInDeployment()) {
    throw new BackupNotInDeploymentError();
  }
  const objectStorage = deps.objectStorage ?? new ObjectStorageService();
  const emitFailure = deps.emitFailure ?? emitBackupFailure;
  const now = new Date();
  const datePrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD
  // Time-stamp the per-run keys so two runs on the same calendar day (e.g. a
  // manual press after the scheduled run) don't overwrite each other.
  const runStamp = now.toISOString().replace(/[:.]/g, "-");

  const run = await storage.createAppBackupRun({
    kind: opts.kind,
    status: "in_progress",
    triggeredBy: opts.triggeredBy ?? null,
    startedAt: now,
  });

  let dbStatus: "success" | "failed" = "failed";
  let filesStatus: "success" | "failed" = "failed";
  let dbDumpKey: string | null = null;
  let dbDumpSizeBytes: number | null = null;
  let fileManifestKey: string | null = null;
  let fileObjectCount: number | null = null;
  let fileCopiedCount: number | null = null;
  let fileTotalSizeBytes: number | null = null;
  const errors: string[] = [];

  // --- Database dump ---
  try {
    const key = `${BACKUP_KEY_PREFIX}${datePrefix}/database-${runStamp}.sql.gz`;
    const { sizeBytes } = await streamDatabaseDump(objectStorage, key);
    dbDumpKey = key;
    dbDumpSizeBytes = sizeBytes;
    dbStatus = "success";
  } catch (err: any) {
    errors.push(`database: ${err?.message ?? String(err)}`);
    workerLog({
      worker: "app_backup",
      event: "app_backup_db_failed",
      detail: (err?.message ?? String(err)).slice(0, 500),
    });
  }

  // --- File manifest + incremental archive ---
  try {
    const result = await backupFiles(objectStorage, `${datePrefix}/${runStamp}`, run.id);
    fileManifestKey = result.manifestKey;
    fileObjectCount = result.objectCount;
    fileCopiedCount = result.copiedCount;
    fileTotalSizeBytes = result.totalSizeBytes;
    if (result.failedCount > 0) {
      // The manifest wrote, but one or more objects could not be archived —
      // the archive is incomplete, so the files half is NOT a clean success.
      filesStatus = "failed";
      errors.push(
        `files: ${result.failedCount}/${result.objectCount} object(s) failed to archive` +
          (result.failedSamples.length > 0 ? ` (${result.failedSamples.join("; ")})` : ""),
      );
      workerLog({
        worker: "app_backup",
        event: "app_backup_files_failed",
        detail: `${result.failedCount}/${result.objectCount} copy failure(s)`.slice(0, 500),
      });
    } else {
      filesStatus = "success";
    }
  } catch (err: any) {
    errors.push(`files: ${err?.message ?? String(err)}`);
    workerLog({
      worker: "app_backup",
      event: "app_backup_files_failed",
      detail: (err?.message ?? String(err)).slice(0, 500),
    });
  }

  const status: AppBackupRun["status"] =
    dbStatus === "success" && filesStatus === "success"
      ? "success"
      : dbStatus === "failed" && filesStatus === "failed"
        ? "failed"
        : "partial";

  const totalSizeBytes =
    (dbDumpSizeBytes ?? 0) + (filesStatus === "success" ? fileTotalSizeBytes ?? 0 : 0);

  await storage.updateAppBackupRun(run.id, {
    status,
    dbStatus,
    filesStatus,
    dbDumpKey,
    fileManifestKey,
    dbDumpSizeBytes,
    fileObjectCount,
    fileCopiedCount,
    fileTotalSizeBytes,
    totalSizeBytes,
    errorMessage: errors.length > 0 ? errors.join(" | ").slice(0, 4000) : null,
    finishedAt: new Date(),
  });

  if (status === "failed" || status === "partial") {
    await emitFailure(status, opts.kind, errors.join(" | "));
  }

  workerLog({
    worker: "app_backup",
    event: "app_backup_completed",
    detail: `status=${status} db=${dbStatus} files=${filesStatus} copied=${fileCopiedCount ?? 0}`,
  });

  return { runId: run.id, status };
}

async function emitBackupFailure(
  status: "failed" | "partial",
  kind: AppBackupKind,
  detail: string,
): Promise<void> {
  const label = status === "partial" ? "PARTIAL" : "FAILED";
  const text =
    `:rotating_light: App backup ${label} (${kind}). ` +
    `One or more artifacts did not complete. Detail: ${detail.slice(0, 800) || "(none)"}`;
  try {
    await notifyByType("infra.backup.failed", { text }, { triggerSource: "scheduled" });
  } catch (err: any) {
    // Never let alerting failure mask the backup outcome.
    workerLog({
      worker: "app_backup",
      event: "app_backup_alert_failed",
      detail: (err?.message ?? String(err)).slice(0, 300),
    });
  }
}
