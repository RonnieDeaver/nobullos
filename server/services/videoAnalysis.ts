// @cross-instance-safe: purely in-process — cleans this instance's own in-memory job store + local /tmp files; no shared side effect.
import { TwelvelabsApiClient } from "twelvelabs-js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { ObjectStorageService, objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import {
  auditedCreateReadStream,
  auditedExists,
  auditedSave,
} from "../replit_integrations/object_storage/audit";

const INDEX_NAME = "replit-video-analysis";

const ALLOWED_BASE_DIRS = [
  path.resolve("attached_assets"),
];

let clientInstance: TwelvelabsApiClient | null = null;
// Test-only override installed via __test_setTwelveLabsClient (bottom of file).
let clientOverride: TwelvelabsApiClient | null = null;

function getClient(): TwelvelabsApiClient {
  if (clientOverride) return clientOverride;
  if (!clientInstance) {
    const apiKey = process.env.TWELVELABS_API_KEY;
    if (!apiKey) {
      throw new Error("TWELVELABS_API_KEY environment variable is not set");
    }
    clientInstance = new TwelvelabsApiClient({ apiKey });
  }
  return clientInstance;
}

export function resolveAndValidateLocalPath(
  filePath?: string,
  attachedAsset?: string
): string {
  let resolvedPath: string;

  if (attachedAsset) {
    const sanitized = path.basename(attachedAsset);
    resolvedPath = path.resolve("attached_assets", sanitized);
  } else if (filePath) {
    resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  } else {
    throw new Error("Provide one of: filePath or attachedAsset");
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const realPath = fs.realpathSync(resolvedPath);
  const isAllowed = ALLOWED_BASE_DIRS.some(
    (base) => realPath.startsWith(base + path.sep) || realPath === base
  );

  if (!isAllowed) {
    throw new Error("Access denied: file path is outside allowed directories");
  }

  return realPath;
}

export async function downloadFromObjectStorage(objectPath: string, userId: string): Promise<string> {
  const objectStorageService = new ObjectStorageService();

  const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

  const hasAccess = await objectStorageService.canAccessObjectEntity({
    userId,
    objectFile,
  });

  if (!hasAccess) {
    throw new Error("Access denied: you do not have permission to access this object");
  }

  const tmpDir = os.tmpdir();
  const ext = path.extname(objectPath) || ".mp4";
  const tmpFile = path.join(tmpDir, `video_${Date.now()}${ext}`);

  const writeStream = fs.createWriteStream(tmpFile);

  return new Promise<string>((resolve, reject) => {
    const readStream = auditedCreateReadStream(objectFile);
    readStream.on("error", (err: Error) => {
      fs.unlink(tmpFile, () => {});
      reject(new Error(`Failed to download from object storage: ${err.message}`));
    });
    writeStream.on("error", (err: Error) => {
      reject(new Error(`Failed to write temp file: ${err.message}`));
    });
    writeStream.on("finish", () => {
      resolve(tmpFile);
    });
    readStream.pipe(writeStream);
  });
}

function cleanupTempFile(filePath: string): void {
  if (filePath.startsWith(os.tmpdir())) {
    fs.unlink(filePath, () => {});
  }
}

export function parseTimestampToSeconds(timestamp: string): number | null {
  const trimmed = timestamp.trim();

  const directNum = parseFloat(trimmed);
  if (!isNaN(directNum) && /^\d+(\.\d+)?$/.test(trimmed)) {
    return directNum;
  }

  const rangeMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(?:seconds?)?$/);
  if (rangeMatch) {
    return parseFloat(rangeMatch[1]);
  }

  const mmssMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (mmssMatch) {
    if (mmssMatch[3] !== undefined) {
      return parseInt(mmssMatch[1]) * 3600 + parseInt(mmssMatch[2]) * 60 + parseInt(mmssMatch[3]);
    }
    return parseInt(mmssMatch[1]) * 60 + parseInt(mmssMatch[2]);
  }

  const secMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)$/i);
  if (secMatch) {
    return parseFloat(secMatch[1]);
  }

  return null;
}

export async function extractFrames(
  videoFilePath: string,
  timestamps: number[],
  taskId: string
): Promise<Map<number, string>> {
  const frameMap = new Map<number, string>();

  if (timestamps.length === 0) return frameMap;

  const uniqueTimestamps = [...new Set(timestamps)].sort((a, b) => a - b);

  const tmpFrameDir = path.join(os.tmpdir(), `video-frames-${taskId}`);
  if (!fs.existsSync(tmpFrameDir)) {
    fs.mkdirSync(tmpFrameDir, { recursive: true });
  }

  const objectStorageService = new ObjectStorageService();
  const privateDir = objectStorageService.getPrivateObjectDir();

  for (const ts of uniqueTimestamps) {
    const safeTs = ts.toFixed(2).replace(".", "_");
    const localFile = path.join(tmpFrameDir, `frame_${safeTs}.png`);

    try {
      if (!Number.isFinite(ts) || ts < 0) {
        console.warn(`[VideoAnalysis] Skipping invalid timestamp: ${ts}`);
        continue;
      }

      execFileSync("ffmpeg", [
        "-y", "-ss", String(ts), "-i", videoFilePath,
        "-frames:v", "1", "-q:v", "2", localFile,
      ], { stdio: "pipe", timeout: 30000 });

      if (!fs.existsSync(localFile)) {
        console.warn(`[VideoAnalysis] Frame extraction produced no file at ts=${ts}`);
        continue;
      }

      const objectName = `video-frames/${taskId}/${safeTs}.png`;
      let fullObjectPath = `${privateDir}/${objectName}`;
      if (fullObjectPath.startsWith("/")) fullObjectPath = fullObjectPath.slice(1);
      const parts = fullObjectPath.split("/");
      const bucketName = parts[0];
      const objectKey = parts.slice(1).join("/");

      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectKey);
      await auditedSave(file, fs.readFileSync(localFile), {
        metadata: { contentType: "image/png" },
      });

      frameMap.set(ts, `/api/video-analysis/frames/${taskId}/${safeTs}.png`);
      console.log(`[VideoAnalysis] Frame extracted and uploaded: ts=${ts}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[VideoAnalysis] Frame extraction failed at ts=${ts}: ${msg}`);
    }
  }

  try {
    fs.rmSync(tmpFrameDir, { recursive: true, force: true });
  } catch {}

  return frameMap;
}

/**
 * Task #3702 — local-only variant of the frame pipeline above. Extracts one
 * JPEG per timestamp into `outDir` and returns them ordered by timestamp,
 * WITHOUT uploading to object storage: the Zoom face-sentiment analyzer
 * feeds the frames straight into a vision call and then discards them
 * (privacy-conservative — no meeting face frames are persisted anywhere).
 * Frames are downscaled to ≤720p JPEG to bound vision-input size. Individual
 * timestamp failures are skipped, mirroring extractFrames.
 *
 * Uses ASYNC child processes (per-frame 30s timeout) — this runs inside the
 * shared app process via the work queue, so a slow/malformed recording must
 * never block the event loop (HTTP + scheduler share it).
 */
export async function extractLocalFrames(
  videoFilePath: string,
  timestamps: number[],
  outDir: string,
): Promise<Array<{ atSec: number; filePath: string }>> {
  const out: Array<{ atSec: number; filePath: string }> = [];
  if (timestamps.length === 0) return out;

  const uniqueTimestamps = [...new Set(timestamps)].sort((a, b) => a - b);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (const ts of uniqueTimestamps) {
    if (!Number.isFinite(ts) || ts < 0) {
      console.warn(`[VideoAnalysis] Skipping invalid local-frame timestamp: ${ts}`);
      continue;
    }
    const safeTs = ts.toFixed(2).replace(".", "_");
    const localFile = path.join(outDir, `frame_${safeTs}.jpg`);
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-ss", String(ts), "-i", videoFilePath,
        "-frames:v", "1", "-vf", "scale=-2:'min(720,ih)'", "-q:v", "4", localFile,
      ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      if (fs.existsSync(localFile)) {
        out.push({ atSec: ts, filePath: localFile });
      } else {
        console.warn(`[VideoAnalysis] Local frame extraction produced no file at ts=${ts}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[VideoAnalysis] Local frame extraction failed at ts=${ts}: ${msg}`);
    }
  }

  return out;
}

export async function getFrameFromStorage(
  taskId: string,
  filename: string
): Promise<{ stream: NodeJS.ReadableStream; contentType: string } | null> {
  const objectStorageService = new ObjectStorageService();
  const privateDir = objectStorageService.getPrivateObjectDir();

  let fullObjectPath = `${privateDir}/video-frames/${taskId}/${filename}`;
  if (fullObjectPath.startsWith("/")) fullObjectPath = fullObjectPath.slice(1);
  const parts = fullObjectPath.split("/");
  const bucketName = parts[0];
  const objectKey = parts.slice(1).join("/");

  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectKey);

  const [exists] = await auditedExists(file);
  if (!exists) return null;

  return {
    stream: auditedCreateReadStream(file),
    contentType: "image/png",
  };
}

async function resolveExistingFrames(
  taskId: string,
  timestamps: number[]
): Promise<Map<number, string>> {
  const frameMap = new Map<number, string>();
  const objectStorageService = new ObjectStorageService();
  const privateDir = objectStorageService.getPrivateObjectDir();

  for (const ts of timestamps) {
    const safeTs = ts.toFixed(2).replace(".", "_");
    const filename = `${safeTs}.png`;

    let fullObjectPath = `${privateDir}/video-frames/${taskId}/${filename}`;
    if (fullObjectPath.startsWith("/")) fullObjectPath = fullObjectPath.slice(1);
    const parts = fullObjectPath.split("/");
    const bucketName = parts[0];
    const objectKey = parts.slice(1).join("/");

    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectKey);
    const [exists] = await auditedExists(file);

    if (exists) {
      frameMap.set(ts, `/api/video-analysis/frames/${taskId}/${filename}`);
    }
  }

  return frameMap;
}

let cachedIndexId: string | null = null;

export async function getOrCreateIndex(): Promise<string> {
  if (cachedIndexId) return cachedIndexId;

  const client = getClient();

  for await (const index of await client.indexes.list({ indexName: INDEX_NAME })) {
    if (index.id) {
      cachedIndexId = index.id;
      console.log(`[VideoAnalysis] Reusing existing index: ${cachedIndexId}`);
      return cachedIndexId;
    }
  }

  const response = await client.indexes.create({
    indexName: INDEX_NAME,
    models: [
      {
        modelName: "marengo2.7",
        modelOptions: ["visual", "audio"],
      },
      {
        modelName: "pegasus1.2",
        modelOptions: ["visual", "audio"],
      },
    ],
  });

  const indexId = response.id;
  if (!indexId) {
    throw new Error("Failed to create TwelveLabs index: no ID returned");
  }

  cachedIndexId = indexId;
  console.log(`[VideoAnalysis] Created new index: ${cachedIndexId}`);
  return cachedIndexId;
}

export interface VideoJob {
  taskId: string;
  videoId?: string;
  indexId: string;
  ownerUserId: string;
  status: "pending" | "indexing" | "validating" | "ready" | "failed" | "timeout";
  filePath: string;
  createdAt: Date;
  completedAt?: Date;
  error?: string;
  /** Task #3972 — which path landed the terminal state (observability only). */
  completionSource?: "webhook" | "poll";
}

const jobStore = new Map<string, VideoJob>();

// ============================================
// TWELVELABS WEBHOOK COMPLETION (Task #3972)
// ============================================
//
// Provider preflight (docs.twelvelabs.io v1.3, read 2026-08-07):
// - Webhooks are registered ONCE, account-wide, on the TwelveLabs dashboard
//   (Playground → Webhooks). The current API has NO per-task callback_url
//   (audit B-011 referenced an older doc revision), so "registering the
//   callback on submission" reduces to recording the taskId → job mapping
//   (jobStore, written by submitVideo) that the webhook handler correlates on.
// - Each delivery carries a `TL-Signature: t=<unix seconds>,v1=<hex>` header
//   where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`) and the secret comes
//   from the dashboard webhook page (env: TWELVELABS_WEBHOOK_SECRET). The
//   docs recommend a 5-minute timestamp tolerance; `t` is HMAC-bound, so once
//   the signature checks out the timestamp is cryptographically trustworthy
//   (same pattern as the Zoom receiver, audit A-004).
// - Indexing events are `index.task.ready` / `index.task.failed` with
//   data.id = the task id. The payload does NOT include the video id, so the
//   ready path performs one tasks.retrieve — the same call a poll iteration
//   would have made.
// - The endpoint must answer 2xx or the dashboard marks it Failed.

/**
 * Webhook mode is opt-in: it activates only when the dashboard secret is
 * present. Without it, submissions keep the primary poll cadence and the
 * receiver route fails closed (503).
 */
export function isTwelveLabsWebhookConfigured(): boolean {
  return Boolean(process.env.TWELVELABS_WEBHOOK_SECRET?.trim());
}

/**
 * Bounded replay window for TwelveLabs webhooks, matching the vendor-suggested
 * 5-minute tolerance and the Zoom receiver's A-004 semantics: inclusive
 * boundary, past AND future drift both rejected beyond the window.
 */
export const TWELVELABS_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Parse `TL-Signature: t=<unix seconds>,v1=<hex hmac>` (order-insensitive). */
export function parseTlSignatureHeader(
  header: string | undefined,
): { t: string; v1: string } | null {
  if (!header || typeof header !== "string") return null;
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && value) t = value;
    else if (key === "v1" && value) v1 = value;
  }
  if (!t || !v1) return null;
  return { t, v1 };
}

/**
 * Verify v1 == HMAC-SHA256(secret, `${t}.${rawBody}`). The raw (unparsed)
 * body bytes must be used — re-serialized JSON would break the signature.
 */
export function verifyTwelveLabsWebhookSignature(
  rawBody: string | Buffer,
  t: string,
  v1: string,
): boolean {
  const secret = process.env.TWELVELABS_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("[VideoAnalysis] TWELVELABS_WEBHOOK_SECRET not configured");
    return false;
  }
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${t}.`);
  hmac.update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
  const expected = hmac.digest("hex");
  const sigBuf = Buffer.from(v1);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Deterministic boundary semantics (mirrors isZoomWebhookTimestampWithinWindow):
 * absolute drift EXACTLY at the window is accepted; one millisecond beyond is
 * rejected; malformed timestamps are rejected.
 */
export function isTwelveLabsTimestampWithinWindow(
  t: string,
  nowMs: number = Date.now(),
): boolean {
  if (typeof t !== "string" || !/^\d+$/.test(t.trim())) return false;
  const tsMs = Number(t.trim()) * 1000;
  if (!Number.isFinite(tsMs)) return false;
  return Math.abs(nowMs - tsMs) <= TWELVELABS_WEBHOOK_REPLAY_WINDOW_MS;
}

/**
 * Single terminal writers shared by the webhook and poll paths. Both no-op on
 * already-terminal jobs, which is what makes repeated webhook deliveries and
 * the webhook-vs-poll race idempotent (Node runs these mutations
 * synchronously, so a plain status guard is a sufficient lock in-process).
 */
function markJobReady(job: VideoJob, videoId: string | undefined, source: "webhook" | "poll"): void {
  if (isTerminalStatus(job.status)) return;
  job.status = "ready";
  job.videoId = videoId;
  job.completedAt = new Date();
  job.completionSource = source;
  console.log(`[VideoAnalysis] Task ${job.taskId} completed via ${source}, videoId: ${job.videoId}`);
}

function markJobFailed(job: VideoJob, error: string, source: "webhook" | "poll"): void {
  if (isTerminalStatus(job.status)) return;
  job.status = "failed";
  job.error = error;
  job.completedAt = new Date();
  job.completionSource = source;
  cleanupTempFile(job.filePath);
  console.error(`[VideoAnalysis] Task ${job.taskId} failed (via ${source})`);
}

export type TwelveLabsWebhookApplyResult =
  | { outcome: "completed"; status: "ready" | "failed" }
  | { outcome: "already_terminal"; status: string }
  | { outcome: "unknown_task" }
  | { outcome: "retrieve_failed"; detail: string }
  | { outcome: "not_terminal_on_retrieve"; status: string };

/**
 * Apply a verified `index.task.ready` / `index.task.failed` webhook event to
 * the local job store. Idempotent: unknown tasks (restart or foreign-instance
 * delivery — the submitting process owns the mapping and its fallback poller
 * owns recovery) and already-terminal jobs are acknowledged no-ops.
 *
 * The ready path re-reads the task from the API because the webhook payload
 * carries no video id; that retrieve also re-confirms terminal state straight
 * from the source, so a spoofed-looking or premature "ready" event can never
 * mark a job ready that the API does not agree is ready.
 */
export async function applyTwelveLabsTaskUpdate(
  taskId: string,
  eventStatus: "ready" | "failed",
): Promise<TwelveLabsWebhookApplyResult> {
  const job = jobStore.get(taskId);
  if (!job) return { outcome: "unknown_task" };
  if (isTerminalStatus(job.status)) {
    return { outcome: "already_terminal", status: job.status };
  }

  if (eventStatus === "failed") {
    markJobFailed(job, "Indexing failed", "webhook");
    return { outcome: "completed", status: "failed" };
  }

  try {
    const task = await getClient().tasks.retrieve(taskId);
    const status = task.status || "unknown";
    if (status === "ready") {
      markJobReady(job, task.videoId, "webhook");
      return { outcome: "completed", status: "ready" };
    }
    if (status === "failed") {
      markJobFailed(job, "Indexing failed", "webhook");
      return { outcome: "completed", status: "failed" };
    }
    // Event said ready but the API does not (yet) agree — leave the job
    // non-terminal and let the bounded fallback poller finish it.
    job.status =
      status === "indexing" ? "indexing" : status === "validating" ? "validating" : "pending";
    return { outcome: "not_terminal_on_retrieve", status };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[VideoAnalysis] Webhook-triggered retrieve failed for ${taskId}: ${detail}`);
    return { outcome: "retrieve_failed", detail };
  }
}

/**
 * Poll cadence (Task #3972): with the webhook configured, polling is only a
 * FALLBACK for missed callbacks, so it runs at a coarse 60s cadence instead
 * of the primary 10s loop (360 → 60 API calls per task worst-case). Both
 * plans keep the same bounded ~1h overall window, and the loop additionally
 * exits as soon as a webhook delivery lands the terminal state.
 */
export function getPollPlan(
  webhookConfigured: boolean = isTwelveLabsWebhookConfigured(),
): { intervalMs: number; maxAttempts: number } {
  return webhookConfigured
    ? { intervalMs: 60_000, maxAttempts: 60 }
    : { intervalMs: 10_000, maxAttempts: 360 };
}

export async function submitVideo(validatedPath: string, ownerUserId: string): Promise<VideoJob> {
  if (!fs.existsSync(validatedPath)) {
    throw new Error(`Video file not found: ${validatedPath}`);
  }

  const client = getClient();
  const indexId = await getOrCreateIndex();

  console.log(`[VideoAnalysis] Uploading video: ${validatedPath}`);

  const fileStream = fs.createReadStream(validatedPath);

  const response = await client.tasks.create(
    {
      indexId,
      videoFile: fileStream,
    },
    { timeoutInSeconds: 600 }
  );

  const taskId = response.id;
  if (!taskId) {
    throw new Error("Failed to create indexing task: no task ID returned");
  }

  const job: VideoJob = {
    taskId,
    indexId,
    ownerUserId,
    status: "pending",
    filePath: validatedPath,
    createdAt: new Date(),
  };

  jobStore.set(taskId, job);
  console.log(
    `[VideoAnalysis] Task created: ${taskId} (completion: ${
      isTwelveLabsWebhookConfigured() ? "webhook + fallback poll" : "poll"
    })`,
  );

  pollTaskCompletion(taskId).catch((err) => {
    console.error(`[VideoAnalysis] Background poll error for ${taskId}:`, err.message);
  });

  return job;
}

async function pollTaskCompletion(
  taskId: string,
  planOverride?: { intervalMs: number; maxAttempts: number },
): Promise<void> {
  const client = getClient();
  const { intervalMs, maxAttempts } = planOverride ?? getPollPlan();

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    // A webhook delivery may have landed the terminal state while we slept —
    // stop polling instead of spending another API call (Task #3972).
    const current = jobStore.get(taskId);
    if (!current || isTerminalStatus(current.status)) return;

    try {
      const task = await client.tasks.retrieve(taskId);
      const status = task.status || "unknown";
      const job = jobStore.get(taskId);

      if (!job) return;
      // Webhook won the race during the retrieve round-trip.
      if (isTerminalStatus(job.status)) return;

      if (status === "ready") {
        markJobReady(job, task.videoId, "poll");
        return;
      } else if (status === "failed") {
        markJobFailed(job, "Indexing failed", "poll");
        return;
      } else {
        job.status = status === "indexing" ? "indexing" : status === "validating" ? "validating" : "pending";
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[VideoAnalysis] Poll attempt ${i + 1} error: ${message}`);
    }
  }

  const job = jobStore.get(taskId);
  if (job && !isTerminalStatus(job.status)) {
    job.status = "timeout";
    job.error = "Polling timed out after 1 hour";
    job.completedAt = new Date();
    cleanupTempFile(job.filePath);
  }
}

const TEMP_FILE_TTL_MS = 30 * 60 * 1000;

// Task #913C: this purely-in-memory cleanup pass doesn't itself touch
// the DB, but wrapping it in attribution keeps any future enrichment
// (e.g. persisting orphan stats) labeled rather than `unknown`.
const _videoAnalysisCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const job of jobStore.values()) {
    if (
      job.status === "ready" &&
      job.completedAt &&
      now - job.completedAt.getTime() > TEMP_FILE_TTL_MS &&
      job.filePath.startsWith(os.tmpdir()) &&
      fs.existsSync(job.filePath)
    ) {
      console.log(`[VideoAnalysis] Cleaning up orphaned temp file for task ${job.taskId}`);
      cleanupTempFile(job.filePath);
    }
  }
}, 5 * 60 * 1000).unref();

export function isTerminalStatus(status: string): boolean {
  return status === "ready" || status === "failed" || status === "timeout";
}

export function getJobStatus(taskId: string, userId: string): VideoJob | null {
  const job = jobStore.get(taskId);
  if (!job || job.ownerUserId !== userId) return null;
  return job;
}

export function getJobsByUser(userId: string): VideoJob[] {
  return Array.from(jobStore.values())
    .filter((job) => job.ownerUserId === userId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function getVideoTranscription(
  taskId: string,
  userId: string
): Promise<{ transcript: Array<{ start?: number; end?: number; value?: string }> } | null> {
  const job = getJobStatus(taskId, userId);
  if (!job || job.status !== "ready" || !job.videoId) return null;

  const client = getClient();

  const video = await client.indexes.videos.retrieve(job.indexId, job.videoId, {
    transcription: true,
  });

  const transcription: Array<{ start?: number; end?: number; value?: string }> =
    Array.isArray(video.transcription) ? video.transcription : [];
  return { transcript: transcription };
}

export async function analyzeVideo(
  taskId: string,
  userId: string,
  prompt?: string
): Promise<{ analysis: string } | null> {
  const job = getJobStatus(taskId, userId);
  if (!job || job.status !== "ready" || !job.videoId) return null;

  const client = getClient();

  const analysisPrompt =
    prompt ||
    "Provide a comprehensive analysis of this video including: 1) A summary of the video content, 2) Key moments with timestamps, 3) Visual scene descriptions, 4) Any notable audio or speech elements. Format the output as structured sections.";

  const response = await client.analyze(
    {
      videoId: job.videoId,
      prompt: analysisPrompt,
      temperature: 0.2,
      maxTokens: 4000,
    },
    { timeoutInSeconds: 120 }
  );

  return { analysis: response.data || "" };
}

export async function searchInVideo(
  taskId: string,
  userId: string,
  query: string
): Promise<{
  results: Array<{
    start?: number;
    end?: number;
    videoId?: string;
    transcription?: string;
  }>;
} | null> {
  const job = getJobStatus(taskId, userId);
  if (!job || job.status !== "ready" || !job.videoId) return null;

  const client = getClient();

  const response = await client.search.create({
    indexId: job.indexId,
    queryText: query,
    searchOptions: ["visual", "audio"],
    filter: JSON.stringify({ id: [job.videoId] }),
  });

  const results = (response.data || []).map((item) => ({
    start: typeof item.start === "number" ? item.start : undefined,
    end: typeof item.end === "number" ? item.end : undefined,
    videoId: item.videoId,
    transcription: item.transcription,
  }));

  return { results };
}

export async function getFullAnalysis(taskId: string, userId: string): Promise<{
  status: string;
  transcript: Array<{ start?: number; end?: number; value?: string }> | null;
  summary: string | null;
  scenes: Array<{ timestamp: string; description: string; frameUrl?: string }> | null;
  keyMoments: Array<{ timestamp: string; description: string; frameUrl?: string }> | null;
} | null> {
  const job = getJobStatus(taskId, userId);
  if (!job || job.status !== "ready" || !job.videoId) return null;

  const client = getClient();

  const [transcriptResult, summaryResult, scenesResult] = await Promise.all([
    getVideoTranscription(taskId, userId).catch(() => null),
    analyzeVideo(
      taskId,
      userId,
      "Provide a concise summary of this video in 2-4 paragraphs. Cover the main topic, key events, and conclusions."
    ).catch(() => null),
    (async () => {
      const resp = await client.analyze(
        {
          videoId: job.videoId!,
          prompt: "Identify distinct visual scenes and key moments in this video. For each scene provide the start and end timestamps in seconds and a description. For key moments provide the timestamp in seconds and a description.",
          temperature: 0.1,
          maxTokens: 4000,
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              type: "object",
              properties: {
                scenes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      timestamp: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
                keyMoments: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      timestamp: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        { timeoutInSeconds: 120 }
      );
      return resp.data || "";
    })().catch(() => null),
  ]);

  let scenes: Array<{ timestamp: string; description: string; frameUrl?: string }> | null = null;
  let keyMoments: Array<{ timestamp: string; description: string; frameUrl?: string }> | null = null;

  if (scenesResult) {
    try {
      const parsed: unknown = typeof scenesResult === "string" ? JSON.parse(scenesResult) : scenesResult;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        scenes = Array.isArray(obj.scenes) ? obj.scenes : null;
        keyMoments = Array.isArray(obj.keyMoments) ? obj.keyMoments : null;
      }
    } catch {
      scenes = null;
      keyMoments = null;
    }
  }

  const allTimestamps: number[] = [];
  const collectTimestamps = (items: Array<{ timestamp: string }> | null) => {
    if (!items) return;
    for (const item of items) {
      const sec = parseTimestampToSeconds(item.timestamp);
      if (sec !== null && sec >= 0) {
        allTimestamps.push(sec);
      }
    }
  };
  collectTimestamps(scenes);
  collectTimestamps(keyMoments);

  if (allTimestamps.length > 0) {
    let frameMap = new Map<number, string>();

    if (fs.existsSync(job.filePath)) {
      try {
        frameMap = await extractFrames(job.filePath, allTimestamps, taskId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[VideoAnalysis] Frame extraction failed for task ${taskId}: ${msg}`);
      }
      cleanupTempFile(job.filePath);
    } else {
      try {
        frameMap = await resolveExistingFrames(taskId, allTimestamps);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[VideoAnalysis] Frame lookup failed for task ${taskId}: ${msg}`);
      }
    }

    const attachFrameUrls = (items: Array<{ timestamp: string; frameUrl?: string }> | null) => {
      if (!items) return;
      for (const item of items) {
        const sec = parseTimestampToSeconds(item.timestamp);
        if (sec !== null && frameMap.has(sec)) {
          item.frameUrl = frameMap.get(sec);
        }
      }
    };
    attachFrameUrls(scenes);
    attachFrameUrls(keyMoments);
  } else {
    cleanupTempFile(job.filePath);
  }

  return {
    status: "ready",
    transcript: transcriptResult?.transcript || null,
    summary: summaryResult?.analysis || null,
    scenes,
    keyMoments,
  };
}

// ---- Test-only seams (Task #3972) ------------------------------------------
// The job store and client singleton are module-private; these narrow hooks
// let the hermetic webhook/fallback tests seed jobs and stub the vendor
// client without touching the real TwelveLabs API (same __test_ convention
// as e.g. server/routes/twilio.ts).

/** Test-only: inject a fake TwelveLabs client. Pass null to restore the real one. */
export function __test_setTwelveLabsClient(client: TwelvelabsApiClient | null): void {
  clientOverride = client;
}

/** Test-only: seed a job into the in-memory store. */
export function __test_seedJob(job: VideoJob): void {
  jobStore.set(job.taskId, job);
}

/** Test-only: remove a seeded job. */
export function __test_deleteJob(taskId: string): void {
  jobStore.delete(taskId);
}

/** Test-only: drive the (fallback) poll loop directly with a tiny plan. */
export const __test_pollTaskCompletion = pollTaskCompletion;
