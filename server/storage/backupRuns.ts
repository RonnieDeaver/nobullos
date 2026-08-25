// @db-pool-intent: worker
//
// Task #2657 — bookkeeping for the daily app-backup job. All callers (the
// backup producer, the scheduler, and the admin GET/POST routes) invoke
// these helpers from a `runWithWorkerDb` + `withDbAttribution` scope, so
// every `getDb()` call in this file is worker-pool bound. The dump itself
// reads prod via `pg_dump` over the direct connection string — never the
// pool — so a long dump/upload never holds a pooled connection.

import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  appBackupRuns,
  type AppBackupRun,
  type InsertAppBackupRun,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

let appBackupRunsTableReady: Promise<void> | null = null;

export async function ensureAppBackupRunsTable(): Promise<void> {
  if (!appBackupRunsTableReady) {
    appBackupRunsTableReady = withDbAttribution(
      "maintenance:app-backup-runs-ensure-table",
      async () => {
        await getDb().execute(sql`
          CREATE TABLE IF NOT EXISTS "app_backup_runs" (
            "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
            "kind" varchar(16) NOT NULL DEFAULT 'scheduled',
            "status" varchar(16) NOT NULL DEFAULT 'in_progress',
            "db_status" varchar(16),
            "files_status" varchar(16),
            "db_dump_key" text,
            "file_manifest_key" text,
            "db_dump_size_bytes" bigint,
            "file_object_count" integer,
            "file_copied_count" integer,
            "file_total_size_bytes" bigint,
            "total_size_bytes" bigint,
            "error_message" text,
            "triggered_by" varchar,
            "started_at" timestamp NOT NULL DEFAULT now(),
            "finished_at" timestamp,
            "created_at" timestamp NOT NULL DEFAULT now()
          )
        `);
        await getDb().execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_app_backup_runs_created_at"
            ON "app_backup_runs" ("created_at" DESC)
        `);
        await getDb().execute(sql`
          CREATE INDEX IF NOT EXISTS "idx_app_backup_runs_status_time"
            ON "app_backup_runs" ("status", "created_at" DESC)
        `);
      },
    ).catch((err) => {
      appBackupRunsTableReady = null;
      throw err;
    });
  }
  return appBackupRunsTableReady;
}

export async function createAppBackupRun(
  data: InsertAppBackupRun,
): Promise<AppBackupRun> {
  await ensureAppBackupRunsTable();
  const [row] = await withDbAttribution(
    "maintenance:app-backup-runs-insert",
    () => getDb().insert(appBackupRuns).values(data).returning(),
  );
  return row;
}

// Task #4380 (F8): dedicated narrow writer type — the backup worker's
// completion write. Row identity/kind/startedAt stay out of the patch.
export type AppBackupRunStoragePatch = Partial<
  Pick<
    InsertAppBackupRun,
    | "status"
    | "dbStatus"
    | "filesStatus"
    | "dbDumpKey"
    | "fileManifestKey"
    | "dbDumpSizeBytes"
    | "fileObjectCount"
    | "fileCopiedCount"
    | "fileTotalSizeBytes"
    | "totalSizeBytes"
    | "errorMessage"
    | "finishedAt"
  >
>;

export async function updateAppBackupRun(
  id: string,
  patch: AppBackupRunStoragePatch,
): Promise<AppBackupRun | undefined> {
  await ensureAppBackupRunsTable();
  const [row] = await withDbAttribution(
    "maintenance:app-backup-runs-update",
    () =>
      getDb()
        .update(appBackupRuns)
        .set(patch)
        .where(eq(appBackupRuns.id, id))
        .returning(),
  );
  return row;
}

export async function listAppBackupRuns(limit = 100): Promise<AppBackupRun[]> {
  await ensureAppBackupRunsTable();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return withDbAttribution("maintenance:app-backup-runs-list", () =>
    getDb()
      .select()
      .from(appBackupRuns)
      .orderBy(desc(appBackupRuns.createdAt), desc(appBackupRuns.id))
      .limit(safeLimit),
  );
}

export async function getAppBackupRun(
  id: string,
): Promise<AppBackupRun | undefined> {
  await ensureAppBackupRunsTable();
  const [row] = await withDbAttribution(
    "maintenance:app-backup-runs-get",
    () =>
      getDb().select().from(appBackupRuns).where(eq(appBackupRuns.id, id)).limit(1),
  );
  return row;
}

/**
 * Task #2657 — sweep runs left `in_progress` past a ceiling (the previous
 * holder crashed/was recycled, releasing the advisory lock but never
 * updating its row). They must be marked `failed` so the admin page never
 * shows a perpetually-spinning run. Returns the number of rows recovered.
 */
export async function failStaleInProgressRuns(
  olderThanMs: number,
): Promise<number> {
  await ensureAppBackupRunsTable();
  const cutoff = new Date(Date.now() - Math.max(0, olderThanMs));
  const rows = await withDbAttribution(
    "maintenance:app-backup-runs-fail-stale",
    () =>
      getDb()
        .update(appBackupRuns)
        .set({
          status: "failed",
          errorMessage:
            "Run did not complete (instance recycled or hung before finishing); recovered by stale sweep.",
          finishedAt: sql`now()` as any,
        })
        .where(
          and(
            eq(appBackupRuns.status, "in_progress"),
            lt(appBackupRuns.startedAt, cutoff),
          ),
        )
        .returning({ id: appBackupRuns.id }),
  );
  return rows.length;
}
