// @db-pool-intent: worker
//
// Task #4023 — Retention purge for client-file Trash.
//
// Trashed client files (client_files.trashed_at set) stay restorable until
// the retention window lapses; this sweep then permanently deletes them:
// every object the file owns (current content + all prior versions) is
// removed from object storage FIRST, and only files whose objects are all
// confirmed gone have their DB rows deleted (via
// clientFileService.purgeFileRows, which cascades version rows and writes a
// `purged` activity entry). Ordering rationale: a dangling DB row is
// visible (404 on download) and re-purgeable next tick, while an orphaned
// CLAIMED object is invisible forever — the abandoned-upload sweep skips
// owned objects by design.
//
// Scheduler conventions (WORKERS_QUEUES_RUNBOOK.md):
//   1. Default OFF — master switch `client_file_trash_purge_enabled`
//      (system setting) must be truthy. Opt-in because the tick performs
//      real object-storage deletes, not just measurement.
//   2. Deployment-gated — the workspace DB is a stale prod clone sharing
//      the SAME object-storage bucket: a workspace purge would delete
//      objects that live PROD rows still reference. Set
//      CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE=1 to bypass locally (tests).
//   3. Cross-instance singleton — each tick runs under a cluster-wide
//      Postgres advisory lock (withWorkerSingletonLock) so exactly one
//      instance sweeps per tick; the lock self-heals on crash.
//   4. Worker pool — DB work runs via runWithWorkerDb.
//   5. KILL_SWITCH_NON_CRITICAL_SWEEPS pauses it fleet-wide.
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } from "./workerConfig";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { runWithWorkerDb, withDbAttribution } from "../db";
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";
import {
  listExpiredTrash,
  purgeFileRows,
  type PurgeTarget,
} from "./clientFileService";

const SINGLETON_KEY = "client_file_trash_purge";

/** Master enable switch. Default OFF — opt-in because the tick performs
 * real object-storage deletes, not just measurement. */
export const SETTING_ENABLED = "client_file_trash_purge_enabled";

/** Retention window in days: a trashed file younger than this is never
 * purged (restorable window). Default 30, bounded 1..365. */
export const SETTING_RETENTION_DAYS = "client_file_trash_purge_retention_days";

/** Per-tick file budget so a huge trash backlog can never fan out an
 * unbounded number of storage deletes in one pass. Default 200, bounded
 * 1..2000 (each file may own several objects — current + versions). */
export const SETTING_MAX_FILES_PER_TICK =
  "client_file_trash_purge_max_files_per_tick";

/** Persisted JSON summary of the most recent tick so operators get a live
 * readout without scraping worker logs. */
export const SETTING_LAST_RUN = "client_file_trash_purge_last_run";

export const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_DAYS_CAP = 365;
const DEFAULT_MAX_FILES_PER_TICK = 200;
const MAX_FILES_PER_TICK_CAP = 2000;

export const TICK_INTERVAL_MS = Number(
  process.env.CLIENT_FILE_TRASH_PURGE_INTERVAL_MS || 24 * 60 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function isForceEnabled(): boolean {
  const v = process.env.CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE;
  return v === "1" || v === "true";
}

export async function loadRetentionDays(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_RETENTION_DAYS).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.min(RETENTION_DAYS_CAP, Math.floor(n));
}

async function loadMaxFilesPerTick(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_MAX_FILES_PER_TICK).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_FILES_PER_TICK;
  return Math.min(MAX_FILES_PER_TICK_CAP, Math.floor(n));
}

export interface ClientFileTrashPurgeTickResult {
  ranAt: string;
  enabled: boolean;
  retentionDays: number;
  maxFilesPerTick: number;
  /** Expired trashed files considered this tick (bounded by the budget). */
  expired: number;
  /** Files fully purged (objects gone + DB rows deleted). */
  purgedFiles: number;
  /** Individual objects deleted (current + version content). */
  deletedObjects: number;
  /** Files skipped because at least one object delete failed — they stay
   * in trash and are retried next tick. */
  filesWithErrors: number;
  reason?: string;
}

async function persistLastRun(
  result: ClientFileTrashPurgeTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[ClientFileTrashPurge] Failed to persist last-run summary: ${err?.message ?? err}`,
    );
  }
}

/** Injectable seams for tests — production uses the real service + clock. */
export interface ClientFileTrashPurgeDeps {
  /** Returns true when the object is gone (deleted or already absent). */
  deleteObject?: (objectKey: string) => Promise<boolean>;
  listExpired?: (retentionDays: number, limit: number) => Promise<PurgeTarget[]>;
  now?: Date;
}

/**
 * One purge pass. Never throws — every failure path lands in the returned
 * summary (and the persisted last-run readout) instead.
 */
export async function runClientFileTrashPurgeTick(
  deps: ClientFileTrashPurgeDeps = {},
): Promise<ClientFileTrashPurgeTickResult> {
  const now = deps.now ?? new Date();
  const enabled =
    isForceEnabled() ||
    parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
  const retentionDays = await loadRetentionDays();
  const maxFilesPerTick = await loadMaxFilesPerTick();
  const result: ClientFileTrashPurgeTickResult = {
    ranAt: now.toISOString(),
    enabled,
    retentionDays,
    maxFilesPerTick,
    expired: 0,
    purgedFiles: 0,
    deletedObjects: 0,
    filesWithErrors: 0,
  };

  if (!enabled) {
    result.reason = "purge disabled in system_settings";
    await persistLastRun(result);
    return result;
  }
  if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
    result.reason = "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
    await persistLastRun(result);
    return result;
  }

  try {
    const objectStorage = new ObjectStorageService();
    const deleteObject =
      deps.deleteObject ??
      ((key: string) => objectStorage.deletePrivateObjectByKey(key));
    const listExpired = deps.listExpired ?? listExpiredTrash;

    const targets = await listExpired(retentionDays, maxFilesPerTick);
    result.expired = targets.length;
    if (targets.length === 0) {
      await persistLastRun(result);
      return result;
    }

    // Objects first, rows second (see header). Group fully-cleared files by
    // client so purgeFileRows batches under each client's advisory lock.
    const clearedByClient = new Map<
      string,
      { fileId: string; name: string; totalBytes: number }[]
    >();
    for (const target of targets) {
      let allGone = true;
      for (const key of target.objectKeys) {
        try {
          await deleteObject(key); // false = already absent — still gone
          result.deletedObjects += 1;
        } catch (err: any) {
          allGone = false;
          console.warn(
            `[ClientFileTrashPurge] Failed to delete ${key}: ${err?.message ?? err}`,
          );
        }
      }
      if (!allGone) {
        result.filesWithErrors += 1;
        continue;
      }
      const list = clearedByClient.get(target.clientId) ?? [];
      list.push({
        fileId: target.fileId,
        name: target.name,
        totalBytes: target.totalBytes,
      });
      clearedByClient.set(target.clientId, list);
    }

    for (const [clientId, files] of clearedByClient) {
      const { purged } = await purgeFileRows({
        clientId,
        files,
        actor: { id: null, name: "Retention sweep" },
        via: "retention_sweep",
      });
      result.purgedFiles += purged;
    }

    if (result.purgedFiles > 0 || result.filesWithErrors > 0) {
      console.log(
        `[ClientFileTrashPurge] Purged expired trash: files=${result.purgedFiles} ` +
          `objects=${result.deletedObjects} errors=${result.filesWithErrors} ` +
          `(retention ${retentionDays}d)`,
      );
    }
  } catch (err: any) {
    result.reason = `sweep failed: ${err?.message ?? err}`;
    console.warn(`[ClientFileTrashPurge] ${result.reason}`);
  }

  await persistLastRun(result);
  return result;
}

async function guardedTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runWithWorkerDb(() =>
      withDbAttribution("scheduler:client-file-trash-purge", () =>
        runClientFileTrashPurgeTick(),
      ),
    );
  } catch (err: any) {
    console.warn(`[ClientFileTrashPurge] tick failed: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}

/**
 * Start the daily purge scheduler. Deployment-gated (see header) and a
 * cross-instance singleton per tick. Default OFF via SETTING_ENABLED.
 */
export function startClientFileTrashPurgeScheduler(): void {
  if (interval) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[ClientFileTrashPurge] Not in deployment — scheduler disabled " +
        "(workspace DB is a prod clone sharing the prod bucket; " +
        "set CLIENT_FILE_TRASH_PURGE_FORCE_ENABLE=1 to override).",
    );
    return;
  }
  interval = setInterval(
    () =>
      void withWorkerSingletonLock(SINGLETON_KEY, () => guardedTick(), undefined, {
        maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.client_file_trash_purge,
      }),
    TICK_INTERVAL_MS,
  );
  if (typeof interval.unref === "function") interval.unref();
  console.log(
    `[ClientFileTrashPurge] Scheduler started (every ${Math.round(TICK_INTERVAL_MS / 60_000)}min, kill switch: ${SETTING_ENABLED})`,
  );
}

export function stopClientFileTrashPurgeScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
