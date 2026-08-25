/* test-registration
{
  "name": "App backup deployment gate + per-object copy failure ⇒ partial (Task #2657)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2657: the daily app-backup producer's two silent-data-loss invariants — (1) it refuses to run outside the deployment (a workspace run would dump the dev DB, not prod) and (2) a per-object archive copy failure makes the run `partial`, never a silent `success`. Gate the service test so a regression in either invariant fails fast (isolated-schema, Object Storage + dispatcher stubbed via loader, `pg_dump` stubbed with `true`).",
  "tier": "small"
}
test-registration */
/**
 * Task #2657 — invariants for the daily app-backup producer
 * (`server/services/appBackup.ts`).
 *
 * Two contracts are pinned here; both guard a silent-data-loss class:
 *
 *   1. DEPLOYMENT GATE. A backup dumps PROD; the dev workspace can only
 *      *read* prod, so a workspace run would dump the wrong (dev) DB and
 *      masquerade as a real backup. `runAppBackup` must refuse — for the
 *      scheduled cron AND the on-demand "Run backup now" press — when
 *      `REPLIT_DEPLOYMENT !== "1"`, throwing `BackupNotInDeploymentError`
 *      BEFORE creating any run row.
 *
 *   2. PER-OBJECT COPY FAILURE ⇒ NEVER A SILENT SUCCESS. A single
 *      Object-Storage object that fails to archive must count against the
 *      run: the files half is `failed`, so a run whose DB dump succeeded
 *      finalizes as `partial` (not `success`) with a descriptive
 *      `errorMessage`. Before the fix the failure was only logged and the
 *      run reported a clean `success` despite an incomplete archive.
 *
 * The producer exposes a test-only injection seam (`RunAppBackupDeps`): we
 * inject a fake `ObjectStorageService` whose `copyObjectToBackupArchive`
 * always throws (and whose `streamUploadToPrivateKey` just drains the stream),
 * plus a no-op failure emitter, so the test never touches real Object Storage
 * or fires notifications. The DB-dump subprocess is stubbed by pointing
 * `PG_DUMP_PATH` at `true` (exits 0, empty output ⇒ the dump half succeeds).
 * The bookkeeping `app_backup_runs` writes run inside `runInIsolatedSchema`
 * (the table is created at runtime by `ensureAppBackupRunsTable`, so there is
 * nothing in `public` to clone — the ensure creates it in the isolated schema)
 * so the live workflow's workers can neither see nor race them.
 */

import assert from "node:assert/strict";

import {
  runAppBackup,
  BackupNotInDeploymentError,
  type RunAppBackupDeps,
} from "../server/services/appBackup";
import type { ObjectStorageService } from "../server/replit_integrations/object_storage";
import { runInIsolatedSchema } from "./db-sandbox";

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

// A fake Object Storage that surfaces one source object whose archive copy
// ALWAYS fails — the exact condition under test for invariant (2).
function makeFailingObjectStorage(): {
  storage: ObjectStorageService;
  copyAttempts: number;
} {
  const state = { copyAttempts: 0 };
  const fake = {
    async listBackupSourceObjects() {
      return [
        {
          fullPath: "public/example-object.png",
          generation: "1",
          sizeBytes: 123,
          contentType: "image/png",
          md5Hash: "deadbeef",
          updated: "2026-06-22T00:00:00.000Z",
        },
      ];
    },
    async copyObjectToBackupArchive() {
      state.copyAttempts += 1;
      throw new Error("simulated copy failure");
    },
    // Drain whatever stream we are handed (the gzipped dump or the manifest)
    // so the producer's pipe completes, then resolve with a size.
    async streamUploadToPrivateKey(_key: string, stream: any) {
      await new Promise<void>((resolve) => {
        if (!stream || typeof stream.on !== "function") return resolve();
        stream.on("data", () => {});
        stream.on("end", resolve);
        stream.on("error", () => resolve());
        stream.on("close", resolve);
      });
      return { size: 0 };
    },
  };
  return {
    storage: fake as unknown as ObjectStorageService,
    get copyAttempts() {
      return state.copyAttempts;
    },
  };
}

async function main(): Promise<void> {
  const priorDeployment = process.env.REPLIT_DEPLOYMENT;
  const priorPgDump = process.env.PG_DUMP_PATH;

  try {
    // ---- 1. Deployment gate ------------------------------------------------
    delete process.env.REPLIT_DEPLOYMENT;
    await assert.rejects(
      () => runAppBackup({ kind: "manual", triggeredBy: "u1" }),
      (err: unknown) => {
        assert.ok(
          err instanceof BackupNotInDeploymentError,
          `expected BackupNotInDeploymentError, got ${String(err)}`,
        );
        return true;
      },
    );
    ok("runAppBackup refuses outside the deployment (manual)");

    process.env.REPLIT_DEPLOYMENT = "0";
    await assert.rejects(
      () => runAppBackup({ kind: "scheduled" }),
      (err: unknown) => err instanceof BackupNotInDeploymentError,
    );
    ok("runAppBackup refuses when REPLIT_DEPLOYMENT='0' (scheduled)");

    // ---- 2. Per-object copy failure ⇒ partial (never silent success) -------
    process.env.REPLIT_DEPLOYMENT = "1";
    process.env.PG_DUMP_PATH = "true"; // exits 0, empty dump ⇒ DB half succeeds

    await runInIsolatedSchema(
      async () => {
        const fake = makeFailingObjectStorage();
        let emittedStatus: string | null = null;
        const deps: RunAppBackupDeps = {
          objectStorage: fake.storage,
          emitFailure: async (status) => {
            emittedStatus = status;
          },
        };

        const result = await runAppBackup(
          { kind: "manual", triggeredBy: "u1" },
          deps,
        );

        assert.equal(
          result.status,
          "partial",
          `DB dump succeeded but file copy failed ⇒ run must be 'partial', got '${result.status}'`,
        );
        assert.ok(fake.copyAttempts > 0, "the copy must have been attempted");
        ok("a failed object copy makes the run 'partial', not 'success'");

        assert.equal(
          emittedStatus,
          "partial",
          "a partial run must fire the failure notification",
        );
        ok("the failure notification fires on a partial run");

        const { storage } = await import("../server/storage");
        const run = await storage.getAppBackupRun(result.runId);
        assert.ok(run, "run row must exist");
        assert.equal(run!.status, "partial", "persisted status must be 'partial'");
        assert.equal(run!.dbStatus, "success", "DB half should be 'success'");
        assert.equal(run!.filesStatus, "failed", "files half must be 'failed'");
        assert.ok(
          (run!.errorMessage ?? "").includes("failed to archive"),
          `errorMessage must describe the copy failure, got: ${run!.errorMessage}`,
        );
        ok("persisted run records files=failed + a descriptive errorMessage");
      },
      // `app_backup_runs` is created at runtime by `ensureAppBackupRunsTable`
      // (CREATE TABLE IF NOT EXISTS), not by a migration, so there is nothing
      // in `public` to clone. With no clone, the ensure call creates the table
      // inside the isolated schema (first on search_path) when the run starts.
      { tables: [] },
    );
  } finally {
    if (priorDeployment === undefined) delete process.env.REPLIT_DEPLOYMENT;
    else process.env.REPLIT_DEPLOYMENT = priorDeployment;
    if (priorPgDump === undefined) delete process.env.PG_DUMP_PATH;
    else process.env.PG_DUMP_PATH = priorPgDump;
  }

  console.log(`\n${passed} assertion(s) passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
