// @db-pool-intent: worker
//
// Task #3520 — Clean up leftover comms draft attachments so object
// storage doesn't grow forever.
//
// Draft pre-uploads land under `comms-draft-attachments/` (originals) and
// `comms-draft-attachments/thumb/` (Task #3438 thumbnails). When a draft
// is promoted into a real message, the bytes are COPIED to
// `comms-attachments/` — the draft original and its thumbnail stay behind.
// Abandoned drafts leave both objects behind too. This module is the
// retention sweep that removes those orphans:
//
//   • Lists every object under `comms-draft-attachments/` (originals +
//     thumbs in one paged list call).
//   • Skips any object still referenced by a live `comms_drafts` row
//     (metadata.attachments[].objectKey / .thumbnailKey), so a draft a
//     user is still sitting on is never broken — regardless of age.
//   • Deletes only objects older than the retention window (default 30
//     days), bounded per tick, best-effort per object (a delete failure
//     is counted and retried on a later tick, never thrown).
//
// The promotion path in server/routes/comms.ts also deletes the draft
// original + thumb inline (best-effort, after the send succeeded); this
// sweep is the backstop for abandoned drafts and any promotion-time
// delete that failed.
//
// Scheduler conventions (WORKERS_QUEUES_RUNBOOK.md):
//   1. Default OFF — master switch `comms_draft_attachment_cleanup_enabled`
//      (system setting) must be truthy. Opt-in because the tick performs
//      real object-storage deletes, not just measurement.
//   2. Deployment-gated — the workspace shares the object-storage bucket
//      with prod but NOT the prod `comms_drafts` table, so a workspace run
//      could delete an object a live PROD draft still references. Set
//      COMMS_DRAFT_CLEANUP_FORCE_ENABLE=1 to bypass locally (tests).
//   3. Cross-instance singleton — each tick runs under a cluster-wide
//      Postgres advisory lock (withWorkerSingletonLock) so exactly one
//      instance sweeps per tick; the lock self-heals on crash.
//   4. Worker pool — the referenced-keys SELECT runs via runWithWorkerDb.
//   5. KILL_SWITCH_NON_CRITICAL_SWEEPS pauses it fleet-wide.
import { sql } from "drizzle-orm";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import {
  ObjectStorageService,
  type PrivatePrefixObject,
} from "../replit_integrations/object_storage/objectStorage";

export const DRAFT_ATTACHMENT_PREFIX = "comms-draft-attachments/";
export const DRAFT_ATTACHMENT_THUMB_PREFIX = "comms-draft-attachments/thumb/";

const SINGLETON_KEY = "comms_draft_attachment_cleanup";

/** Master enable switch. Default OFF — opt-in because the tick performs
 * real object-storage deletes, not just measurement. */
export const SETTING_ENABLED = "comms_draft_attachment_cleanup_enabled";

/** Retention window in days: a draft object younger than this is never
 * deleted even if unreferenced (covers in-flight uploads whose draft row
 * hasn't been saved yet). Default 30, bounded 1..365. */
export const SETTING_RETENTION_DAYS =
  "comms_draft_attachment_cleanup_retention_days";

/** Per-tick delete budget so a huge orphan backlog can never fan out an
 * unbounded number of storage deletes in one pass. Default 200, bounded
 * 1..2000. */
export const SETTING_MAX_DELETES_PER_TICK =
  "comms_draft_attachment_cleanup_max_deletes_per_tick";

/** Persisted JSON summary of the most recent tick so operators get a live
 * readout without scraping worker logs. */
export const SETTING_LAST_RUN = "comms_draft_attachment_cleanup_last_run";

const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_DAYS_CAP = 365;
const DEFAULT_MAX_DELETES_PER_TICK = 200;
const MAX_DELETES_PER_TICK_CAP = 2000;

export const TICK_INTERVAL_MS = Number(
  process.env.COMMS_DRAFT_CLEANUP_INTERVAL_MS || 24 * 60 * 60_000,
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
  const v = process.env.COMMS_DRAFT_CLEANUP_FORCE_ENABLE;
  return v === "1" || v === "true";
}

async function loadRetentionDays(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_RETENTION_DAYS).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.min(RETENTION_DAYS_CAP, Math.floor(n));
}

async function loadMaxDeletesPerTick(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_MAX_DELETES_PER_TICK).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_DELETES_PER_TICK;
  return Math.min(MAX_DELETES_PER_TICK_CAP, Math.floor(n));
}

/**
 * Collect every draft-prefix object key still referenced by a live
 * `comms_drafts` row. Draft metadata shape (written by the client after
 * the pre-upload route responds):
 *   metadata.attachments: [{ objectKey, thumbnailKey?, ... }, ...]
 * Defensive parse — malformed metadata contributes no keys but never
 * throws (an unparseable draft simply can't protect any keys, and the
 * retention window still protects recent objects).
 */
export async function collectReferencedDraftKeys(): Promise<Set<string>> {
  const referenced = new Set<string>();
  const res = await withDbAttribution(
    "commsDraftAttachmentCleanup:selectDraftMetadata",
    async () =>
      getDb().execute(
        sql`SELECT metadata FROM comms_drafts WHERE metadata IS NOT NULL`,
      ),
  );
  for (const row of (res as any).rows ?? []) {
    let meta: any = row.metadata;
    if (typeof meta === "string") {
      try {
        meta = JSON.parse(meta);
      } catch {
        continue;
      }
    }
    const attachments = Array.isArray(meta?.attachments)
      ? meta.attachments
      : [];
    for (const a of attachments) {
      for (const key of [a?.objectKey, a?.thumbnailKey]) {
        if (
          typeof key === "string" &&
          key.startsWith(DRAFT_ATTACHMENT_PREFIX)
        ) {
          referenced.add(key);
        }
      }
    }
  }
  return referenced;
}

export interface DraftAttachmentCleanupTickResult {
  ranAt: string;
  enabled: boolean;
  retentionDays: number;
  maxDeletesPerTick: number;
  /** Objects listed under the draft prefix (originals + thumbs). */
  listed: number;
  /** Objects skipped because a live draft still references them. */
  referenced: number;
  /** Objects skipped because they are younger than the retention window
   * (or have no readable creation time — treated as young, never deleted). */
  tooYoung: number;
  deleted: number;
  /** Per-object delete failures (logged; retried on a later tick). */
  errors: number;
  /** True when the per-tick budget was exhausted with candidates left. */
  budgetExhausted: boolean;
  reason?: string;
}

async function persistLastRun(
  result: DraftAttachmentCleanupTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[CommsDraftCleanup] Failed to persist last-run summary: ${err?.message ?? err}`,
    );
  }
}

/** Injectable seams for tests — production uses the real service + clock. */
export interface DraftAttachmentCleanupDeps {
  listObjects?: () => Promise<PrivatePrefixObject[]>;
  deleteObject?: (objectKey: string) => Promise<boolean>;
  loadReferencedKeys?: () => Promise<Set<string>>;
  now?: Date;
}

/**
 * One cleanup pass. Never throws — every failure path lands in the
 * returned summary (and the persisted last-run readout) instead.
 */
export async function runDraftAttachmentCleanupTick(
  deps: DraftAttachmentCleanupDeps = {},
): Promise<DraftAttachmentCleanupTickResult> {
  const now = deps.now ?? new Date();
  const enabled =
    isForceEnabled() ||
    parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
  const retentionDays = await loadRetentionDays();
  const maxDeletesPerTick = await loadMaxDeletesPerTick();
  const result: DraftAttachmentCleanupTickResult = {
    ranAt: now.toISOString(),
    enabled,
    retentionDays,
    maxDeletesPerTick,
    listed: 0,
    referenced: 0,
    tooYoung: 0,
    deleted: 0,
    errors: 0,
    budgetExhausted: false,
  };

  if (!enabled) {
    result.reason = "cleanup disabled in system_settings";
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
    const listObjects =
      deps.listObjects ??
      (() => objectStorage.listPrivateObjectsByPrefix(DRAFT_ATTACHMENT_PREFIX));
    const deleteObject =
      deps.deleteObject ??
      ((key: string) => objectStorage.deletePrivateObjectByKey(key));
    const loadReferencedKeys =
      deps.loadReferencedKeys ?? collectReferencedDraftKeys;

    const [objects, referencedKeys] = await Promise.all([
      listObjects(),
      loadReferencedKeys(),
    ]);
    result.listed = objects.length;

    const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60_000;
    for (const obj of objects) {
      if (referencedKeys.has(obj.objectKey)) {
        result.referenced += 1;
        continue;
      }
      // No readable creation time → treat as young (never delete blind).
      if (!obj.timeCreated || obj.timeCreated.getTime() > cutoffMs) {
        result.tooYoung += 1;
        continue;
      }
      if (result.deleted + result.errors >= maxDeletesPerTick) {
        result.budgetExhausted = true;
        break;
      }
      try {
        await deleteObject(obj.objectKey);
        result.deleted += 1;
      } catch (err: any) {
        result.errors += 1;
        console.warn(
          `[CommsDraftCleanup] Failed to delete ${obj.objectKey}: ${err?.message ?? err}`,
        );
      }
    }
    if (result.deleted > 0 || result.errors > 0) {
      console.log(
        `[CommsDraftCleanup] Swept draft attachments: listed=${result.listed} ` +
          `deleted=${result.deleted} referenced=${result.referenced} ` +
          `tooYoung=${result.tooYoung} errors=${result.errors}` +
          (result.budgetExhausted ? " (budget exhausted, more next tick)" : ""),
      );
    }
  } catch (err: any) {
    result.reason = `sweep failed: ${err?.message ?? err}`;
    console.warn(`[CommsDraftCleanup] ${result.reason}`);
  }

  await persistLastRun(result);
  return result;
}

async function guardedTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runWithWorkerDb(() =>
      withDbAttribution("scheduler:comms-draft-attachment-cleanup", () =>
        runDraftAttachmentCleanupTick(),
      ),
    );
  } catch (err: any) {
    console.warn(`[CommsDraftCleanup] tick failed: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}

/**
 * Start the daily cleanup scheduler. Deployment-gated (see header) and a
 * cross-instance singleton per tick. Default OFF via SETTING_ENABLED.
 */
export function startCommsDraftAttachmentCleanupScheduler(): void {
  if (interval) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[CommsDraftCleanup] Not in deployment — scheduler disabled " +
        "(workspace shares the bucket with prod but not the prod drafts table; " +
        "set COMMS_DRAFT_CLEANUP_FORCE_ENABLE=1 to override).",
    );
    return;
  }
  interval = setInterval(
    () => void withWorkerSingletonLock(SINGLETON_KEY, () => guardedTick()),
    TICK_INTERVAL_MS,
  );
  if (typeof interval.unref === "function") interval.unref();
  console.log(
    `[CommsDraftCleanup] Scheduler started (every ${Math.round(TICK_INTERVAL_MS / 60_000)}min, kill switch: ${SETTING_ENABLED})`,
  );
}

export function stopCommsDraftAttachmentCleanupScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
