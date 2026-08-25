// @db-pool-intent: worker
//
// Task #2409 — auto-process feedback video attachments through the existing
// TwelveLabs video-analysis tool. For every video uploaded with an in-app
// feedback submission we download it from Object Storage, index it, then pull
// a transcript + key-moment frames and persist them on the feedback row's
// `video_analysis` column. That way the planning agent (and the admin console)
// can read the transcript and view the extracted screenshots without having to
// replay the raw video.
//
// This runs detached in the background (the submit request returns immediately)
// and on the worker pool — all DB writes are wrapped in `runWithWorkerDb` so
// `getDb()` resolves the background pool, and the only DB holds are the short
// status/result UPDATEs (never across the TwelveLabs HTTP / ffmpeg work).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sql } from "drizzle-orm";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";
import { auditedCreateReadStream } from "../replit_integrations/object_storage/audit";
import {
  submitVideo,
  getJobStatus,
  getFullAnalysis,
  isTerminalStatus,
} from "./videoAnalysis";
import { isVideoAttachmentPath } from "@shared/attachments";

export interface FeedbackVideoFrame {
  /** Timestamp label from the AI scene/key-moment detection. */
  timestamp: string;
  description: string;
  /** Authenticated `/api/video-analysis/frames/...` URL of the extracted PNG. */
  url: string;
}

export interface FeedbackVideoResult {
  /** The `/objects/...` path of the uploaded video this row describes. */
  sourcePath: string;
  status: "ready" | "failed";
  transcript: string | null;
  summary: string | null;
  frames: FeedbackVideoFrame[];
  error?: string;
}

export interface FeedbackVideoAnalysis {
  status: "processing" | "ready" | "failed";
  startedAt: string;
  completedAt?: string;
  videos: FeedbackVideoResult[];
  /**
   * Task #2414 — how many times this row's analysis has been re-driven by
   * the restart-resume sweep (`feedbackVideoResume.ts`). 0/undefined for a
   * first run; bumped each time the sweep picks up a row left `processing`
   * by a server restart, so the sweep can eventually give up instead of
   * re-driving a permanently-stuck row forever. Survives a re-drive because
   * the value is threaded back in via `processFeedbackVideos`' `resumeAttempt`
   * option and re-stamped on both the in-progress and terminal persists.
   */
  resumeAttempts?: number;
}

// Poll cadence mirrors videoAnalysis.ts' own background poller (10s × 360 ≈ 1h)
// so we don't out-wait or under-wait the indexing job it kicked off.
const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_ATTEMPTS = 360;

async function downloadFeedbackVideoToTemp(objectPath: string): Promise<string> {
  const storage = new ObjectStorageService();
  // Feedback uploads carry no ACL, so we stream the bytes directly rather than
  // going through the ACL-checked `downloadFromObjectStorage`. The caller has
  // already confirmed this path belongs to the feedback row.
  const objectFile = await storage.getObjectEntityFile(objectPath);
  const ext = path.extname(objectPath) || ".mp4";
  const tmpFile = path.join(os.tmpdir(), `feedback_video_${Date.now()}${ext}`);

  await new Promise<void>((resolve, reject) => {
    const readStream = auditedCreateReadStream(objectFile);
    const writeStream = fs.createWriteStream(tmpFile);
    readStream.on("error", (err: Error) => {
      fs.unlink(tmpFile, () => {});
      reject(err);
    });
    writeStream.on("error", reject);
    writeStream.on("finish", () => resolve());
    readStream.pipe(writeStream);
  });

  return tmpFile;
}

async function waitForJobTerminal(taskId: string, userId: string): Promise<string> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const job = getJobStatus(taskId, userId);
    if (job && isTerminalStatus(job.status)) return job.status;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return getJobStatus(taskId, userId)?.status ?? "timeout";
}

function transcriptToText(
  transcript: Array<{ start?: number; end?: number; value?: string }> | null,
): string | null {
  if (!transcript || transcript.length === 0) return null;
  const text = transcript
    .map((t) => (t.value ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return text || null;
}

function collectFrames(
  scenes: Array<{ timestamp: string; description: string; frameUrl?: string }> | null,
  keyMoments: Array<{ timestamp: string; description: string; frameUrl?: string }> | null,
): FeedbackVideoFrame[] {
  const frames: FeedbackVideoFrame[] = [];
  const seen = new Set<string>();
  for (const item of [...(scenes ?? []), ...(keyMoments ?? [])]) {
    if (item.frameUrl && !seen.has(item.frameUrl)) {
      seen.add(item.frameUrl);
      frames.push({
        timestamp: item.timestamp,
        description: item.description,
        url: item.frameUrl,
      });
    }
  }
  return frames;
}

async function processOneVideo(
  sourcePath: string,
  userId: string,
): Promise<FeedbackVideoResult> {
  let tmpFile: string | null = null;
  try {
    tmpFile = await downloadFeedbackVideoToTemp(sourcePath);
    const job = await submitVideo(tmpFile, userId);
    // submitVideo owns the temp file's lifecycle from here (it cleans it up on
    // failure/timeout and after frame extraction in getFullAnalysis).
    tmpFile = null;

    const status = await waitForJobTerminal(job.taskId, userId);
    if (status !== "ready") {
      return {
        sourcePath,
        status: "failed",
        transcript: null,
        summary: null,
        frames: [],
        error: `Video indexing ${status}`,
      };
    }

    const full = await getFullAnalysis(job.taskId, userId);
    if (!full) {
      return {
        sourcePath,
        status: "failed",
        transcript: null,
        summary: null,
        frames: [],
        error: "Analysis unavailable after indexing",
      };
    }

    return {
      sourcePath,
      status: "ready",
      transcript: transcriptToText(full.transcript),
      summary: full.summary,
      frames: collectFrames(full.scenes, full.keyMoments),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[FeedbackVideo] Processing failed for ${sourcePath}: ${msg}`);
    return {
      sourcePath,
      status: "failed",
      transcript: null,
      summary: null,
      frames: [],
      error: msg,
    };
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

async function persistAnalysis(
  feedbackId: number,
  analysis: FeedbackVideoAnalysis,
): Promise<void> {
  await withDbAttribution("feedback:videoAnalysisPersist", async () => {
    await getDb().execute(sql`
      UPDATE user_feedback
      SET video_analysis = ${JSON.stringify(analysis)}::jsonb
      WHERE id = ${feedbackId}
    `);
  });
}

/**
 * Download → index → transcribe → frame-extract every video attached to a
 * feedback submission, persisting the results on the row's `video_analysis`
 * column. Best-effort and idempotent at the row level (the column is simply
 * overwritten with the latest run). Intended to be called detached from the
 * submit request — it does its own worker-pool DB context and never throws to
 * the caller.
 */
export async function processFeedbackVideos(
  feedbackId: number,
  attachmentPaths: string[],
  userId: string,
  opts?: {
    /**
     * Task #2414 — set by the restart-resume sweep when it re-drives a row
     * left `processing` by a server restart. Persisted on the row's
     * `video_analysis.resumeAttempts` (on both the in-progress and terminal
     * writes) so the counter survives this re-drive and the sweep can give
     * up after a bounded number of attempts. Omitted on the first
     * (submit-time) run.
     */
    resumeAttempt?: number;
  },
): Promise<void> {
  const videoPaths = attachmentPaths.filter((p) => isVideoAttachmentPath(p));
  if (videoPaths.length === 0) return;

  await runWithWorkerDb(async () => {
    const analysis: FeedbackVideoAnalysis = {
      status: "processing",
      startedAt: new Date().toISOString(),
      videos: [],
      ...(opts?.resumeAttempt != null
        ? { resumeAttempts: opts.resumeAttempt }
        : {}),
    };

    try {
      await persistAnalysis(feedbackId, analysis);

      for (const videoPath of videoPaths) {
        const result = await processOneVideo(videoPath, userId);
        analysis.videos.push(result);
      }

      analysis.status = analysis.videos.some((v) => v.status === "ready")
        ? "ready"
        : "failed";
      analysis.completedAt = new Date().toISOString();
      await persistAnalysis(feedbackId, analysis);
      console.log(
        `[FeedbackVideo] Feedback #${feedbackId}: ${analysis.status} (${analysis.videos.length} video(s))`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[FeedbackVideo] Feedback #${feedbackId} failed: ${msg}`);
      analysis.status = "failed";
      analysis.completedAt = new Date().toISOString();
      try {
        await persistAnalysis(feedbackId, analysis);
      } catch {
        /* swallow — the row simply keeps its prior video_analysis value */
      }
    }
  });
}
