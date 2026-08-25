// @db-pool-intent: worker
//
// @cross-instance-safe: enqueue-only setInterval. It only emits a single
// dedupe-keyed `feedback_video_resume` job per tick bucket; the actual
// re-drive runs as ONE work_queue job claimed FOR UPDATE SKIP LOCKED by a
// single instance (handler wraps the tick in runWithWorkerDb). So even with
// every autoscale instance running this scheduler, the sweep itself runs once.
//
// The candidate SELECT, the give-up UPDATEs, and the status re-read all
// resolve their handle via `getDb()`. The only caller of
// `runFeedbackVideoResumeTick()` is the `feedback_video_resume` work-queue
// handler, which wraps it in `runWithWorkerDb(...)` so `getDb()` resolves to
// the worker pool. The actual re-drive delegates to `processFeedbackVideos`,
// which opens its own `runWithWorkerDb` context.
/**
 * Task #2414 — Make feedback video analysis survive a server restart.
 *
 * Uploaded feedback videos are auto-analyzed in the background through the
 * TwelveLabs tool (`feedbackVideoProcessing.processFeedbackVideos`). That
 * processor tracks the in-flight indexing job only in process memory
 * (`videoAnalysis.ts` jobStore), so if the server restarts while a feedback
 * video is still processing, the in-memory job is orphaned and the feedback
 * row is left with `video_analysis.status === "processing"` forever — its
 * transcript / key-moment frames never land.
 *
 * This module closes that gap: a bounded, default-OFF, worker-pool scheduler
 * that periodically scans `user_feedback` rows whose `video_analysis.status`
 * has been stuck `processing` past a threshold (longer than any healthy run
 * could legitimately take) and re-drives them through the SAME shared
 * processor the submit path uses. Re-driving overwrites the row's
 * `video_analysis` in place, so it is idempotent at the row level.
 *
 * Give-up. Each re-drive carries a `resumeAttempt` counter that survives the
 * re-drive (persisted on `video_analysis.resumeAttempts`). Once a row has been
 * re-driven `maxAttempts` times and is STILL stuck `processing` (e.g. the
 * server keeps restarting mid-analysis, or the video is permanently
 * un-indexable), the next tick marks it terminally `failed` instead of
 * re-driving forever. A row whose attachments no longer contain any video is
 * likewise marked terminally `failed` so it stops being a candidate.
 *
 * Bounding. Each tick re-drives at most `maxPerTick` rows (oldest first) so a
 * backlog can never fan out an unbounded number of TwelveLabs submissions in a
 * single pass. The re-drive is awaited per-row, so the work is serial.
 *
 * Gating (default OFF — opt-in because the tick performs real TwelveLabs
 * indexing submissions + ffmpeg work, not just measurement):
 *   1. `feedback_video_resume_enabled` system setting (master switch).
 *   2. `feedback_video_resume` queue-drain pause.
 *   3. `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
 */
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import { isVideoAttachmentPath } from "@shared/attachments";

export const QUEUE_NAME = "feedback_video_resume";

/** Master enable switch. Default OFF — opt-in because the tick performs real
 * TwelveLabs indexing submissions, not just measurement. */
export const SETTING_ENABLED = "feedback_video_resume_enabled";

/** Per-tick budget: how many stuck rows to re-drive per tick so a large
 * backlog can never fan out an unbounded number of TwelveLabs submissions in
 * a single pass. Bounded 1..MAX. */
export const SETTING_MAX_PER_TICK = "feedback_video_resume_max_per_tick";

/** Minimum age (minutes) a row must have been stuck in `processing` (since
 * `video_analysis.startedAt`) before it is treated as orphaned by a restart.
 * Must comfortably exceed the longest legitimate run (the processor polls the
 * TwelveLabs job for up to ~1h), so an in-flight job in a healthy process is
 * never mistaken for an orphan. Bounded 1..MAX. */
export const SETTING_STUCK_MINUTES = "feedback_video_resume_stuck_minutes";

/** Give-up threshold: once a row has been re-driven this many times and is
 * still stuck `processing`, the next tick marks it terminally `failed` instead
 * of re-driving again. Bounded 1..MAX. */
export const SETTING_MAX_ATTEMPTS = "feedback_video_resume_max_attempts";

/** Persisted JSON summary of the most recent tick so operators get a live
 * readout of what the sweep last did (and why) without scraping worker logs. */
export const SETTING_LAST_RUN = "feedback_video_resume_last_run";

const DEFAULT_MAX_PER_TICK = 5;
export const MAX_PER_TICK_CAP = 50;
const DEFAULT_STUCK_MINUTES = 120; // 2h — comfortably past the ~1h poll ceiling
export const STUCK_MINUTES_CAP = 24 * 60; // 24h
const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_ATTEMPTS_CAP = 20;

export const TICK_INTERVAL_MS = Number(
  process.env.FEEDBACK_VIDEO_RESUME_INTERVAL_MS || 15 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

async function loadMaxPerTick(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_MAX_PER_TICK).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_PER_TICK;
  return Math.min(MAX_PER_TICK_CAP, Math.floor(n));
}

async function loadStuckMinutes(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_STUCK_MINUTES).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STUCK_MINUTES;
  return Math.min(STUCK_MINUTES_CAP, Math.floor(n));
}

async function loadMaxAttempts(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_MAX_ATTEMPTS).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS_CAP, Math.floor(n));
}

export interface FeedbackVideoResumeConfig {
  enabled: boolean;
  maxPerTick: number;
  stuckMinutes: number;
  maxAttempts: number;
  tickIntervalMinutes: number;
}

/**
 * Read the current resume config (master switch + bounding knobs) so an
 * operator surface can show what the scheduler will do on its next tick
 * without scraping `system_settings`.
 */
export async function getFeedbackVideoResumeConfig(): Promise<FeedbackVideoResumeConfig> {
  const [enabled, maxPerTick, stuckMinutes, maxAttempts] = await Promise.all([
    Promise.resolve(
      parseBool(
        (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
        false,
      ),
    ),
    loadMaxPerTick(),
    loadStuckMinutes(),
    loadMaxAttempts(),
  ]);
  return {
    enabled,
    maxPerTick,
    stuckMinutes,
    maxAttempts,
    tickIntervalMinutes: Math.round(TICK_INTERVAL_MS / 60_000),
  };
}

export type ResumeOutcome = "resumed" | "gave_up" | "no_videos" | "error";

export interface ResumeAttempt {
  feedbackId: number;
  outcome: ResumeOutcome;
  /** Resume attempt number this row reached (post-increment) for "resumed". */
  attempt?: number;
  /** Terminal status the row landed on after a re-drive ("ready"/"failed"). */
  finalStatus?: string;
  /** Populated when `outcome === "error"`. */
  error?: string;
}

export interface FeedbackVideoResumeTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  maxPerTick: number;
  stuckMinutes: number;
  maxAttempts: number;
  /** Rows stuck `processing` past the threshold at scan time. */
  candidates: number;
  attempted: ResumeAttempt[];
  resumed: number;
  gaveUp: number;
  noVideos: number;
  errors: number;
  reason?: string;
}

async function persistLastRun(
  result: FeedbackVideoResumeTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[FeedbackVideoResume] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

/**
 * Why the last-run summary could not be returned as a parsed object:
 *   - "ok"         — a well-formed summary was read.
 *   - "never_run"  — the key is absent/empty; normal on a fresh deploy.
 *   - "unreadable" — the stored value (or the settings read itself) failed to
 *     produce a summary; signals a real persistence bug, not a fresh deploy.
 */
export type LastFeedbackVideoResumeRunStatus = "ok" | "never_run" | "unreadable";

export interface LastFeedbackVideoResumeRunRead {
  lastRun: FeedbackVideoResumeTickResult | null;
  status: LastFeedbackVideoResumeRunStatus;
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so an operator
 * status route can tell "never ran" (normal) apart from "stored value was
 * unreadable" (a persistence regression). Never throws.
 */
export async function readLastFeedbackVideoResumeRun(): Promise<LastFeedbackVideoResumeRunRead> {
  let raw: string | undefined;
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    raw = row?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FeedbackVideoResume] Failed to read last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }

  if (!raw) return { lastRun: null, status: "never_run" };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as FeedbackVideoResumeTickResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.warn(`[FeedbackVideoResume] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FeedbackVideoResume] Failed to parse last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/** Thin back-compat wrapper: returns the parsed summary or null. */
export async function getLastFeedbackVideoResumeRun(): Promise<FeedbackVideoResumeTickResult | null> {
  return (await readLastFeedbackVideoResumeRun()).lastRun;
}

interface CandidateRow {
  id: number;
  userId: string;
  /** Stored attachment paths (the claimed `/objects/...` strings). */
  screenshotPaths: string[];
  /** Resume attempts already recorded on the row's video_analysis. */
  resumeAttempts: number;
}

function parseScreenshotPaths(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is string => typeof p === "string");
    }
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * Mark a row's `video_analysis` terminally `failed` with an explanatory error,
 * preserving the existing `startedAt` / `resumeAttempts` and any video results
 * already captured. Used by the give-up and no-videos branches so a row stops
 * being a candidate. Idempotent.
 */
async function markResumeFailed(
  feedbackId: number,
  errorMessage: string,
): Promise<void> {
  await withDbAttribution("feedbackVideoResume:markFailed", async () => {
    await getDb().execute(sql`
      UPDATE user_feedback
      SET video_analysis = jsonb_set(
        jsonb_set(
          COALESCE(video_analysis, '{}'::jsonb),
          '{status}', '"failed"'::jsonb, true
        ),
        '{completedAt}', to_jsonb(${new Date().toISOString()}::text), true
      ) || jsonb_build_object('resumeError', ${errorMessage}::text)
      WHERE id = ${feedbackId}
        AND COALESCE(video_analysis->>'status', '') = 'processing'
    `);
  });
}

async function readRowStatus(feedbackId: number): Promise<string | null> {
  return withDbAttribution("feedbackVideoResume:readStatus", async () => {
    const res = await getDb().execute(sql`
      SELECT video_analysis->>'status' AS status
      FROM user_feedback
      WHERE id = ${feedbackId}
    `);
    const row = res.rows?.[0] as { status?: string } | undefined;
    return row?.status ?? null;
  });
}

/**
 * One resume pass. Scans `user_feedback` for rows stuck `processing` past the
 * threshold and re-drives each through the shared processor, bounded by the
 * per-tick budget. Rows past the give-up threshold (or with no remaining video
 * attachments) are marked terminally `failed`. Never throws on a per-row
 * failure — the next tick retries. Persists the summary as the last-run readout.
 */
export async function runFeedbackVideoResumeTick(opts?: {
  now?: Date;
}): Promise<FeedbackVideoResumeTickResult> {
  const result = await computeFeedbackVideoResumeTick(opts);
  await persistLastRun(result);
  return result;
}

async function computeFeedbackVideoResumeTick(opts?: {
  now?: Date;
}): Promise<FeedbackVideoResumeTickResult> {
  const now = opts?.now ?? new Date();
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const maxPerTick = await loadMaxPerTick();
  const stuckMinutes = await loadStuckMinutes();
  const maxAttempts = await loadMaxAttempts();
  const result: FeedbackVideoResumeTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    maxPerTick,
    stuckMinutes,
    maxAttempts,
    candidates: 0,
    attempted: [],
    resumed: 0,
    gaveUp: 0,
    noVideos: 0,
    errors: 0,
  };

  if (!enabled) {
    result.reason = "resume disabled in system_settings";
    return result;
  }
  if (paused) {
    result.reason = "queue paused via queue_drain_state";
    return result;
  }
  if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
    result.reason = "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
    return result;
  }

  // Candidates: rows still `processing` whose `startedAt` is older than the
  // stuck threshold. A healthy in-flight job re-stamps `startedAt` to now() at
  // the start of every run (including the re-drive), so anything older than the
  // threshold cannot be an active job in a healthy process — it was orphaned by
  // a restart. Oldest-first so a long-stuck row is not starved by newer ones.
  const candidates = await withDbAttribution(
    "feedbackVideoResume:selectCandidates",
    async () => {
      const res = await getDb().execute(sql`
        SELECT id, user_id, screenshots, video_analysis
        FROM user_feedback
        WHERE video_analysis->>'status' = 'processing'
          AND (video_analysis->>'startedAt') IS NOT NULL
          AND (video_analysis->>'startedAt')::timestamptz
              < now() - (${stuckMinutes} * interval '1 minute')
        ORDER BY (video_analysis->>'startedAt')::timestamptz ASC, id ASC
        LIMIT ${maxPerTick}
      `);
      return (res.rows ?? []).map((row: any): CandidateRow => {
        const va = row.video_analysis ?? {};
        const attemptsRaw = Number(va?.resumeAttempts);
        return {
          id: Number(row.id),
          userId: String(row.user_id ?? ""),
          screenshotPaths: parseScreenshotPaths(row.screenshots),
          resumeAttempts: Number.isFinite(attemptsRaw) ? attemptsRaw : 0,
        };
      });
    },
  );

  result.candidates = candidates.length;
  if (candidates.length === 0) {
    result.reason = "no feedback rows stuck in processing past the threshold";
    return result;
  }

  const { processFeedbackVideos } = await import("./feedbackVideoProcessing");

  for (const row of candidates) {
    const videoPaths = row.screenshotPaths.filter((p) =>
      isVideoAttachmentPath(p),
    );

    // No video attachments left to resume — nothing the processor can do, so
    // mark terminal so the row stops being a candidate.
    if (videoPaths.length === 0) {
      try {
        await markResumeFailed(
          row.id,
          "Resume gave up: no video attachments found on the feedback row",
        );
      } catch (err: any) {
        console.warn(
          `[FeedbackVideoResume] markFailed (no_videos) failed for feedback=${row.id}: ${
            err?.message ?? err
          }`,
        );
      }
      result.attempted.push({ feedbackId: row.id, outcome: "no_videos" });
      result.noVideos += 1;
      continue;
    }

    // Give-up: re-driven too many times and still stuck. Mark terminal so the
    // sweep stops re-driving a permanently-stuck row forever.
    if (row.resumeAttempts >= maxAttempts) {
      try {
        await markResumeFailed(
          row.id,
          `Resume gave up after ${row.resumeAttempts} attempt(s): video still stuck in processing`,
        );
      } catch (err: any) {
        console.warn(
          `[FeedbackVideoResume] markFailed (gave_up) failed for feedback=${row.id}: ${
            err?.message ?? err
          }`,
        );
      }
      result.attempted.push({
        feedbackId: row.id,
        outcome: "gave_up",
        attempt: row.resumeAttempts,
      });
      result.gaveUp += 1;
      continue;
    }

    // Re-drive through the shared processor. It overwrites `video_analysis` in
    // place (re-stamping `startedAt` to now, which also "claims" the row away
    // from a concurrent instance's threshold check) and carries the bumped
    // `resumeAttempt` so the counter survives. It never throws to us.
    const nextAttempt = row.resumeAttempts + 1;
    try {
      await processFeedbackVideos(row.id, videoPaths, row.userId, {
        resumeAttempt: nextAttempt,
      });
      const finalStatus = (await readRowStatus(row.id)) ?? "unknown";
      result.attempted.push({
        feedbackId: row.id,
        outcome: "resumed",
        attempt: nextAttempt,
        finalStatus,
      });
      result.resumed += 1;
    } catch (err: any) {
      console.warn(
        `[FeedbackVideoResume] re-drive threw for feedback=${row.id}: ${
          err?.message ?? err
        }`,
      );
      result.attempted.push({
        feedbackId: row.id,
        outcome: "error",
        attempt: nextAttempt,
        error: err?.message ? String(err.message).slice(0, 200) : "re-drive threw",
      });
      result.errors += 1;
    }
  }

  return result;
}

/**
 * Enqueue a single dedupe-keyed `feedback_video_resume` job for the current
 * tick bucket. Skips entirely when the master switch is off (so a default-OFF
 * deploy never piles up no-op jobs) or the queue is paused. The actual work
 * runs in the worker pool via the queue handler.
 */
async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[FeedbackVideoResume] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
      );
      return;
    }
    const enabled = parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
    if (!enabled) return;
    const { enqueueJob } = await import("./workScheduler");
    const bucket = Math.floor(Date.now() / TICK_INTERVAL_MS);
    await enqueueJob({
      queueName: QUEUE_NAME,
      workloadClass: "maintenance",
      priority: 200,
      payload: { trigger: "scheduled", bucket },
      dedupeKey: `${QUEUE_NAME}:scheduled:${bucket}`,
      maxAttempts: 2,
    });
  } catch (err: any) {
    console.warn(
      `[FeedbackVideoResume] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startFeedbackVideoResumeScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[FeedbackVideoResume] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopFeedbackVideoResumeScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __feedbackVideoResumeTestHelpers = {
  enqueueScheduledTick,
  loadMaxPerTick,
  loadStuckMinutes,
  loadMaxAttempts,
  parseScreenshotPaths,
};
