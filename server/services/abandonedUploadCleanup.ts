// @db-pool-intent: worker
//
// Task #3983 — Clean up abandoned presigned uploads so object storage
// doesn't grow forever.
//
// Presigned upload URLs (feedback attachments, ATS interview videos,
// heatmap/report screenshots) let the browser PUT an object directly
// into the private bucket BEFORE the claim/submit step runs. When the
// flow is abandoned (tab closed mid-feedback, ATS answer never
// submitted), the object stays behind: unclaimed (no ACL owner),
// unreferenced by any DB row, and invisible. Task #3964 deletes REJECTED
// uploads at claim time; this sweep is the reaper for never-claimed ones:
//
//   • Lists every object under the presigned-upload namespaces:
//     `uploads/` (generic/heatmap), `feedback-uploads/`, and `ats-`
//     (candidate-bound `ats-<candidateId>/` video namespaces).
//   • Skips any object that HAS an ACL owner — a claimed object belongs
//     to a completed flow and is never touched, regardless of age.
//   • Skips any object still referenced by a DB record (belt-and-braces
//     for pre-ACL-era objects): user_feedback.screenshots paths,
//     ats_submissions.video_url / video_object_key, and report-section
//     heatmapImageUrl references.
//   • Deletes only objects older than the grace window (default 48h),
//     bounded per tick, via the race-safe rejected-upload delete
//     (re-reads the ACL + metageneration precondition, so a claim racing
//     in mid-sweep aborts the delete instead of destroying a now-owned
//     object). Per-object failures are counted and retried next tick.
//
// Scheduler conventions (WORKERS_QUEUES_RUNBOOK.md):
//   1. Default OFF — master switch `abandoned_upload_cleanup_enabled`
//      (system setting) must be truthy. Opt-in because the tick performs
//      real object-storage deletes, not just measurement.
//   2. Deployment-gated — the workspace shares the object-storage bucket
//      with prod but NOT the prod reference tables, so a workspace run
//      could delete an object a live PROD row still references. Set
//      ABANDONED_UPLOAD_CLEANUP_FORCE_ENABLE=1 to bypass locally (tests).
//   3. Cross-instance singleton — each tick runs under a cluster-wide
//      Postgres advisory lock (withWorkerSingletonLock) so exactly one
//      instance sweeps per tick; the lock self-heals on crash.
//   4. Worker pool — the reference SELECTs run via runWithWorkerDb.
//   5. KILL_SWITCH_NON_CRITICAL_SWEEPS pauses it fleet-wide.
import { sql } from "drizzle-orm";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } from "./workerConfig";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { collectHeatmapObjectPaths } from "./heatmapImageAcl";
import { HEATMAP_THUMB_SUFFIX } from "../../shared/heatmapScan";
import {
  ObjectStorageService,
  type PrivatePrefixObject,
} from "../replit_integrations/object_storage/objectStorage";

/**
 * The presigned-upload namespaces this sweep owns. Every
 * getObjectEntityUploadURL caller mints into one of these:
 *   - `uploads/`          — generic default (heatmap/report screenshots)
 *   - `feedback-uploads/` — feedback attachments (Task #3964)
 *   - `ats-`              — candidate-bound `ats-<candidateId>/` videos
 *   - `client-files/`     — client file storage `client-files/<clientId>/`
 *                           (Task #4023, minted by getClientFileUploadURL)
 * Deliberately does NOT include `comms-draft-attachments/` (its own sweep,
 * Task #3520), `backups/`, or `comms-attachments/`.
 */
export const ABANDONED_UPLOAD_PREFIXES = [
  "uploads/",
  "feedback-uploads/",
  "ats-",
  "client-files/",
] as const;

const SINGLETON_KEY = "abandoned_upload_cleanup";

/** Master enable switch. Default OFF — opt-in because the tick performs
 * real object-storage deletes, not just measurement. */
export const SETTING_ENABLED = "abandoned_upload_cleanup_enabled";

/** Grace window in hours: an object younger than this is never deleted
 * even if unclaimed + unreferenced (covers in-flight uploads whose claim
 * hasn't run yet). Default 48, bounded 1..8760. */
export const SETTING_GRACE_HOURS = "abandoned_upload_cleanup_grace_hours";

/** Per-tick delete budget so a huge orphan backlog can never fan out an
 * unbounded number of storage deletes in one pass. Default 200, bounded
 * 1..2000. */
export const SETTING_MAX_DELETES_PER_TICK =
  "abandoned_upload_cleanup_max_deletes_per_tick";

/** Persisted JSON summary of the most recent tick so operators get a live
 * readout without scraping worker logs. */
export const SETTING_LAST_RUN = "abandoned_upload_cleanup_last_run";

const DEFAULT_GRACE_HOURS = 48;
const GRACE_HOURS_CAP = 8760;
const DEFAULT_MAX_DELETES_PER_TICK = 200;
const MAX_DELETES_PER_TICK_CAP = 2000;

export const TICK_INTERVAL_MS = Number(
  process.env.ABANDONED_UPLOAD_CLEANUP_INTERVAL_MS || 24 * 60 * 60_000,
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
  const v = process.env.ABANDONED_UPLOAD_CLEANUP_FORCE_ENABLE;
  return v === "1" || v === "true";
}

async function loadGraceHours(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_GRACE_HOURS).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GRACE_HOURS;
  return Math.min(GRACE_HOURS_CAP, Math.floor(n));
}

async function loadMaxDeletesPerTick(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_MAX_DELETES_PER_TICK).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_DELETES_PER_TICK;
  return Math.min(MAX_DELETES_PER_TICK_CAP, Math.floor(n));
}

/** `/objects/<key>` → `<key>` (PRIVATE_OBJECT_DIR-relative object key). */
function objectPathToKey(path: unknown): string | null {
  if (typeof path !== "string") return null;
  if (!path.startsWith("/objects/")) return null;
  const key = path.slice("/objects/".length);
  return key.length > 0 ? key : null;
}

/**
 * Collect every upload-namespace object key still referenced by a DB
 * record. Defensive parse throughout — a malformed row contributes no
 * keys but never throws (it simply can't protect any keys; the ACL-owner
 * skip and grace window still protect legitimately claimed/recent
 * objects). Reference sources:
 *   1. user_feedback.screenshots — JSON array of `/objects/...` paths.
 *   2. ats_submissions.video_url (`/objects/...`) + video_object_key.
 *   3. report_sections (marketing) — gbpLocations[].heatmapImageUrl /
 *      gbp.locations[].heatmapImageUrl `/objects/...` paths.
 */
export async function collectReferencedUploadKeys(): Promise<Set<string>> {
  const referenced = new Set<string>();
  const add = (candidate: unknown) => {
    const key = objectPathToKey(candidate);
    if (key) referenced.add(key);
    // ats_submissions.video_object_key holds a bare key (no /objects/).
    else if (typeof candidate === "string" && candidate && !candidate.startsWith("/")) {
      referenced.add(candidate);
    }
  };

  const feedbackRows = await withDbAttribution(
    "abandonedUploadCleanup:selectFeedbackScreenshots",
    async () =>
      getDb().execute(
        sql`SELECT screenshots FROM user_feedback
            WHERE screenshots IS NOT NULL AND screenshots != '[]'`,
      ),
  );
  for (const row of (feedbackRows as any).rows ?? []) {
    try {
      const parsed = JSON.parse(String(row.screenshots ?? "[]"));
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          const key = objectPathToKey(p);
          if (key) referenced.add(key);
        }
      }
    } catch {
      // malformed JSON protects nothing
    }
  }

  const atsRows = await withDbAttribution(
    "abandonedUploadCleanup:selectAtsVideoRefs",
    async () =>
      getDb().execute(
        sql`SELECT video_url, video_object_key FROM ats_submissions
            WHERE video_url IS NOT NULL OR video_object_key IS NOT NULL`,
      ),
  );
  for (const row of (atsRows as any).rows ?? []) {
    add(row.video_url);
    add(row.video_object_key);
  }

  // Task #4023 — client-file rows always own their objects (claim stamps an
  // ACL owner, so the `owned` skip already protects them); this reference
  // sweep is belt-and-braces against any pre-ACL/manual write. Current
  // content + prior versions both count.
  const clientFileRows = await withDbAttribution(
    "abandonedUploadCleanup:selectClientFileKeys",
    async () =>
      getDb().execute(
        sql`SELECT object_key FROM client_files
            UNION
            SELECT object_key FROM client_file_versions`,
      ),
  );
  for (const row of (clientFileRows as any).rows ?? []) {
    if (typeof row.object_key === "string" && row.object_key) {
      referenced.add(row.object_key);
    }
  }

  const sectionRows = await withDbAttribution(
    "abandonedUploadCleanup:selectHeatmapRefs",
    async () =>
      getDb().execute(
        sql`SELECT data FROM report_sections WHERE section_key = 'marketing'`,
      ),
  );
  for (const row of (sectionRows as any).rows ?? []) {
    let data: any = row.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        continue;
      }
    }
    for (const path of collectHeatmapObjectPaths([
      { sectionKey: "marketing", data },
    ])) {
      const key = objectPathToKey(path);
      if (key) {
        referenced.add(key);
        // Task #4544 — a referenced scan owns its derived `__thumb` variant
        // (deterministic sibling key; no DB row of its own).
        referenced.add(`${key}${HEATMAP_THUMB_SUFFIX}`);
      }
    }
  }

  return referenced;
}

export interface AbandonedUploadCleanupTickResult {
  ranAt: string;
  enabled: boolean;
  graceHours: number;
  maxDeletesPerTick: number;
  /** Objects listed across all upload prefixes. */
  listed: number;
  /** Objects skipped because they carry an ACL owner (claimed). */
  owned: number;
  /** Objects skipped because a DB record still references them. */
  referenced: number;
  /** Objects skipped because they are younger than the grace window
   * (or have no readable creation time — treated as young, never deleted). */
  tooYoung: number;
  deleted: number;
  /** Per-object delete failures/skips (logged; retried on a later tick).
   * Includes race-aborted deletes where a claim landed mid-sweep. */
  errors: number;
  /** True when the per-tick budget was exhausted with candidates left. */
  budgetExhausted: boolean;
  reason?: string;
}

async function persistLastRun(
  result: AbandonedUploadCleanupTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[AbandonedUploadCleanup] Failed to persist last-run summary: ${err?.message ?? err}`,
    );
  }
}

/** Injectable seams for tests — production uses the real service + clock. */
export interface AbandonedUploadCleanupDeps {
  listObjects?: () => Promise<PrivatePrefixObject[]>;
  /** Returns true when the object is gone; false = skipped/failed (counted
   * as an error and retried next tick). Must never destroy an owned object
   * — production wires the race-safe deleteRejectedUploadObject. */
  deleteObject?: (objectKey: string) => Promise<boolean>;
  loadReferencedKeys?: () => Promise<Set<string>>;
  now?: Date;
}

/**
 * One cleanup pass. Never throws — every failure path lands in the
 * returned summary (and the persisted last-run readout) instead.
 */
export async function runAbandonedUploadCleanupTick(
  deps: AbandonedUploadCleanupDeps = {},
): Promise<AbandonedUploadCleanupTickResult> {
  const now = deps.now ?? new Date();
  const enabled =
    isForceEnabled() ||
    parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
  const graceHours = await loadGraceHours();
  const maxDeletesPerTick = await loadMaxDeletesPerTick();
  const result: AbandonedUploadCleanupTickResult = {
    ranAt: now.toISOString(),
    enabled,
    graceHours,
    maxDeletesPerTick,
    listed: 0,
    owned: 0,
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
      (async () => {
        const all: PrivatePrefixObject[] = [];
        for (const prefix of ABANDONED_UPLOAD_PREFIXES) {
          all.push(...(await objectStorage.listPrivateObjectsByPrefix(prefix)));
        }
        return all;
      });
    // Production delete = the Task #3964 race-safe path: re-reads the ACL and
    // pins the delete to that metadata snapshot's metageneration, so a claim
    // racing in between the listing and the delete aborts (counted as an
    // error and re-examined next tick — by then it's owned and skipped).
    const deleteObject =
      deps.deleteObject ??
      ((key: string) =>
        objectStorage.deleteRejectedUploadObject(`/objects/${key}`, {
          expectedOwner: null,
        }));
    const loadReferencedKeys =
      deps.loadReferencedKeys ?? collectReferencedUploadKeys;

    const [objects, referencedKeys] = await Promise.all([
      listObjects(),
      loadReferencedKeys(),
    ]);
    result.listed = objects.length;

    const cutoffMs = now.getTime() - graceHours * 60 * 60_000;
    for (const obj of objects) {
      // A claimed object belongs to a completed flow — never touched.
      if (obj.aclOwner) {
        result.owned += 1;
        continue;
      }
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
        const gone = await deleteObject(obj.objectKey);
        if (gone) {
          result.deleted += 1;
        } else {
          // Skipped (claimed mid-sweep) or failed — retried next tick.
          result.errors += 1;
        }
      } catch (err: any) {
        result.errors += 1;
        console.warn(
          `[AbandonedUploadCleanup] Failed to delete ${obj.objectKey}: ${err?.message ?? err}`,
        );
      }
    }
    if (result.deleted > 0 || result.errors > 0) {
      console.log(
        `[AbandonedUploadCleanup] Swept abandoned uploads: listed=${result.listed} ` +
          `deleted=${result.deleted} owned=${result.owned} ` +
          `referenced=${result.referenced} tooYoung=${result.tooYoung} ` +
          `errors=${result.errors}` +
          (result.budgetExhausted ? " (budget exhausted, more next tick)" : ""),
      );
    }
  } catch (err: any) {
    result.reason = `sweep failed: ${err?.message ?? err}`;
    console.warn(`[AbandonedUploadCleanup] ${result.reason}`);
  }

  await persistLastRun(result);
  return result;
}

async function guardedTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runWithWorkerDb(() =>
      withDbAttribution("scheduler:abandoned-upload-cleanup", () =>
        runAbandonedUploadCleanupTick(),
      ),
    );
  } catch (err: any) {
    console.warn(`[AbandonedUploadCleanup] tick failed: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}

/**
 * Start the daily cleanup scheduler. Deployment-gated (see header) and a
 * cross-instance singleton per tick. Default OFF via SETTING_ENABLED.
 */
export function startAbandonedUploadCleanupScheduler(): void {
  if (interval) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[AbandonedUploadCleanup] Not in deployment — scheduler disabled " +
        "(workspace shares the bucket with prod but not the prod reference tables; " +
        "set ABANDONED_UPLOAD_CLEANUP_FORCE_ENABLE=1 to override).",
    );
    return;
  }
  interval = setInterval(
    () =>
      void withWorkerSingletonLock(SINGLETON_KEY, () => guardedTick(), undefined, {
        maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.abandoned_upload_cleanup,
      }),
    TICK_INTERVAL_MS,
  );
  if (typeof interval.unref === "function") interval.unref();
  console.log(
    `[AbandonedUploadCleanup] Scheduler started (every ${Math.round(TICK_INTERVAL_MS / 60_000)}min, kill switch: ${SETTING_ENABLED})`,
  );
}

export function stopAbandonedUploadCleanupScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
