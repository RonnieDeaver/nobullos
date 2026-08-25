// @db-pool-intent: worker
// @cross-instance-safe: enqueue-only tick — the scheduler only enqueues a
// dedupe-keyed work_queue sweep job (zoom_face_sentiment_sweep:tick);
// duplicate enqueues from concurrent instances collapse via wq_dedupe_key_idx
// and the per-record analyze jobs are dedupe-keyed + idempotent (terminal
// statuses skip before any external call).
//
// Task #3702 — Client face sentiment analysis from Zoom meeting video.
//
// Points the existing video-analysis frame pipeline (ffmpeg frame extraction,
// see videoAnalysis.extractLocalFrames) at Zoom cloud recordings: downloads
// the meeting MP4 via the authenticated Zoom URL, samples frames at even
// intervals through the call, and runs one vision-model pass to produce an
// emotional read of the CLIENT (overall sentiment + a per-sample timeline +
// notable moments). The result is stored on the communication record at
// `rawPayloadJson.zoomFaceSentiment` (see @shared/zoomSentiment for the
// shape and the client-identification decision doc) and surfaced in the
// meeting detail modal, clearly labeled AI-derived.
//
// Pipeline placement: this is a fully independent background lane —
// enumeration + per-record work run through the durable work queue on the
// `maintenance` workload class (cap 1), so it can never block or slow the
// recording/transcript ingest pipeline. Opt-in via the
// `zoom_face_sentiment_enabled` feature switch (default OFF), also gated on
// the `non_critical_sweeps` kill switch, with a per-sweep batch cap.
//
// Failure semantics: the per-record handler NEVER throws for analysis
// problems — every outcome is persisted as a reviewable status:
//   analyzed  — client face read across sampled frames.
//   no_video  — explicit "no video to analyze" (no MP4 / recording gone /
//               client not visible). Terminal.
//   failed    — download/frame/vision error; retried by the sweep until
//               ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS, then parked (visible in
//               the modal). Zoom auth/scope-gate failures do NOT consume an
//               attempt — an auth outage would otherwise burn every record's
//               budget while no work is possible; those records retry
//               automatically once the integration reconnects.
// Restart-safety: state lives on the record row itself (not in-memory job
// registries), enumeration is a pure DB query, and per-record jobs are
// dedupe-keyed — a restart mid-analysis just re-runs the record on the next
// sweep. Frames are analyzed from /tmp and deleted in `finally`; no face
// frames are persisted to object storage.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { sql } from "drizzle-orm";

import { getDb, withDbAttribution } from "../db";
import { storage } from "../storage";
import { isKillSwitchEnabled } from "./killSwitches";
import { enqueueJob, registerHandler } from "./workScheduler";
import type { WorkQueueJob } from "@shared/schema";
import {
  ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS,
  ZOOM_FACE_SENTIMENT_VERSION,
  formatSentimentTimestamp,
  zoomClientOverallSentiments,
  zoomTimelineSentiments,
  type ZoomClientOverallSentiment,
  type ZoomFaceSentimentNoVideoReason,
  type ZoomFaceSentimentResult,
  type ZoomSentimentNotableMoment,
  type ZoomSentimentTimelinePoint,
  type ZoomTimelineSentiment,
} from "@shared/zoomSentiment";

export const ZOOM_FACE_SENTIMENT_SWEEP_QUEUE = "zoom_face_sentiment_sweep";
export const ZOOM_FACE_SENTIMENT_ANALYZE_QUEUE = "zoom_face_sentiment_analyze";

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_CAP = 3;
const MAX_BATCH_CAP = 10;
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 365;
/** Refuse to download recordings larger than this (long all-hands etc.). */
const MAX_VIDEO_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
/** Frame-sampling bounds: one frame ≈ every 4 minutes, clamped 4..12. */
const TARGET_SECONDS_PER_FRAME = 240;
const MIN_FRAMES = 4;
const MAX_FRAMES = 12;

const BATCH_CAP_SETTING_KEY = "zoom_face_sentiment_batch_cap";
const LOOKBACK_SETTING_KEY = "zoom_face_sentiment_lookback_days";

// ── Gating ────────────────────────────────────────────────────────────────

export function isZoomFaceSentimentEnabled(): boolean {
  // Opt-in feature switch (TRUE = on, default false) AND the global
  // non-critical-sweeps kill switch (TRUE = stop everything non-critical).
  return (
    isKillSwitchEnabled("zoom_face_sentiment_enabled") &&
    !isKillSwitchEnabled("non_critical_sweeps")
  );
}

async function readBatchCap(): Promise<number> {
  try {
    const row = await storage.getSystemSetting(BATCH_CAP_SETTING_KEY);
    const v = row?.value ? Number(row.value) : NaN;
    if (Number.isFinite(v) && v >= 1) return Math.min(Math.floor(v), MAX_BATCH_CAP);
  } catch {
    // fall through to default
  }
  return DEFAULT_BATCH_CAP;
}

async function readLookbackDays(): Promise<number> {
  try {
    const row = await storage.getSystemSetting(LOOKBACK_SETTING_KEY);
    const v = row?.value ? Number(row.value) : NaN;
    if (Number.isFinite(v) && v >= 1) return Math.min(Math.floor(v), MAX_LOOKBACK_DAYS);
  } catch {
    // fall through to default
  }
  return DEFAULT_LOOKBACK_DAYS;
}

// ── Frame-sampling plan (pure) ────────────────────────────────────────────

/**
 * Evenly spaced sample timestamps across 5%..95% of the meeting, one frame
 * ≈ every 4 minutes, clamped to [4, 12] frames. Skips the very start/end
 * (joins, goodbyes, empty rooms).
 */
export function planSampleTimestamps(durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const count = Math.min(
    MAX_FRAMES,
    Math.max(MIN_FRAMES, Math.round(durationSec / TARGET_SECONDS_PER_FRAME)),
  );
  const start = durationSec * 0.05;
  const end = durationSec * 0.95;
  if (count === 1) return [Math.round(((start + end) / 2) * 100) / 100];
  const step = (end - start) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round((start + i * step) * 100) / 100);
  }
  return out;
}

// ── Vision outcome parsing (pure) ─────────────────────────────────────────

export interface VisionAnalysisOutcome {
  clientVisible: boolean;
  clientIdentification: {
    description: string;
    confidence: "high" | "medium" | "low";
  };
  overall?: ZoomClientOverallSentiment;
  summary?: string;
  timeline?: ZoomSentimentTimelinePoint[];
  notableMoments?: ZoomSentimentNotableMoment[];
  framesWithClientVisible?: number;
}

/**
 * Parse the vision model's strict-JSON reply into a validated outcome.
 * `frameAtSecs[i]` is the meeting-relative timestamp of frame i+1 (the
 * model refers to frames by 1-based index). Throws on malformed replies —
 * the caller records that as a `failed` (retryable) outcome, never a
 * made-up reading.
 */
export function parseVisionOutcome(
  raw: string,
  frameAtSecs: number[],
): VisionAnalysisOutcome {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`vision reply was not valid JSON (${raw.slice(0, 120)}…)`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("vision reply JSON was not an object");
  }

  const confidenceRaw = String(parsed.client_identification?.confidence ?? "low").toLowerCase();
  const confidence: "high" | "medium" | "low" =
    confidenceRaw === "high" ? "high" : confidenceRaw === "medium" ? "medium" : "low";
  const identification = {
    description: String(parsed.client_identification?.description ?? "").slice(0, 500),
    confidence,
  };

  const clientVisible = parsed.client_visible === true;
  if (!clientVisible) {
    return { clientVisible: false, clientIdentification: identification };
  }

  const overall = String(parsed.overall ?? "").toLowerCase();
  if (!(zoomClientOverallSentiments as readonly string[]).includes(overall)) {
    throw new Error(`vision reply overall sentiment invalid: ${JSON.stringify(parsed.overall)}`);
  }

  const timeline: ZoomSentimentTimelinePoint[] = [];
  let framesWithClientVisible = 0;
  const frames = Array.isArray(parsed.frames) ? parsed.frames : [];
  for (const f of frames) {
    const idx = Number(f?.frame);
    if (!Number.isInteger(idx) || idx < 1 || idx > frameAtSecs.length) continue;
    if (f?.client_visible === false) continue;
    framesWithClientVisible++;
    const sentiment = String(f?.sentiment ?? "").toLowerCase();
    timeline.push({
      atSec: frameAtSecs[idx - 1],
      sentiment: (zoomTimelineSentiments as readonly string[]).includes(sentiment)
        ? (sentiment as ZoomTimelineSentiment)
        : "unclear",
      ...(f?.note ? { note: String(f.note).slice(0, 300) } : {}),
    });
  }

  const notableMoments: ZoomSentimentNotableMoment[] = [];
  const moments = Array.isArray(parsed.notable_moments) ? parsed.notable_moments : [];
  for (const m of moments.slice(0, 8)) {
    const idx = Number(m?.frame);
    const note = String(m?.note ?? "").trim();
    if (!Number.isInteger(idx) || idx < 1 || idx > frameAtSecs.length || !note) continue;
    notableMoments.push({ atSec: frameAtSecs[idx - 1], note: note.slice(0, 300) });
  }

  return {
    clientVisible: true,
    clientIdentification: identification,
    overall: overall as ZoomClientOverallSentiment,
    summary: String(parsed.summary ?? "").slice(0, 1000),
    timeline,
    notableMoments,
    framesWithClientVisible,
  };
}

// ── Injectable deps (design seam for tests: ESM static imports can't be
//    monkey-patched, so the per-record processor takes its external-world
//    edges as an injectable bundle with real defaults) ─────────────────────

export interface FaceSentimentDeps {
  /** Live GET /meetings/{uuid}/recordings via the authenticated Zoom API. */
  fetchRecordingSet(meetingUuid: string): Promise<any>;
  /** Stream an authenticated recording download to destPath. */
  downloadVideo(downloadUrl: string, destPath: string): Promise<void>;
  /** ffprobe the container duration; null when unknown. Sync return values
   * are accepted for test stubs; the real impl is async (never blocks the
   * shared event loop). */
  probeDurationSec(filePath: string): Promise<number | null> | number | null;
  /** Extract one local JPEG per timestamp (existing video-analysis pipeline). */
  extractFrames(
    videoFilePath: string,
    timestamps: number[],
    outDir: string,
  ): Promise<Array<{ atSec: number; filePath: string }>>;
  /** One vision call over all sampled frames. */
  analyzeFrames(input: {
    frames: Array<{ atSec: number; filePath: string }>;
    meeting: {
      topic: string;
      durationSec: number;
      teamParticipants: string[];
      clientParticipants: string[];
    };
  }): Promise<{ outcome: VisionAnalysisOutcome; model: string }>;
  now(): Date;
}

async function defaultFetchRecordingSet(meetingUuid: string): Promise<any> {
  const { fetchMeetingRecordingSet } = await import("./zoomIntegration");
  return fetchMeetingRecordingSet(meetingUuid);
}

async function defaultDownloadVideo(downloadUrl: string, destPath: string): Promise<void> {
  const { getAccessToken } = await import("./zoomIntegration");
  const token = await getAccessToken();
  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`recording download failed: HTTP ${res.status}`);
  }
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_VIDEO_DOWNLOAD_BYTES) {
    throw new Error(`recording too large to analyze (${contentLength} bytes)`);
  }
  let written = 0;
  const counter = new (await import("stream")).Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > MAX_VIDEO_DOWNLOAD_BYTES) {
        cb(new Error(`recording exceeded download cap mid-stream (${written} bytes)`));
        return;
      }
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as any),
    counter,
    fs.createWriteStream(destPath),
  );
}

async function defaultProbeDurationSec(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    const v = parseFloat(String(stdout).trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function defaultExtractFrames(
  videoFilePath: string,
  timestamps: number[],
  outDir: string,
): Promise<Array<{ atSec: number; filePath: string }>> {
  const { extractLocalFrames } = await import("./videoAnalysis");
  return extractLocalFrames(videoFilePath, timestamps, outDir);
}

async function defaultAnalyzeFrames(input: {
  frames: Array<{ atSec: number; filePath: string }>;
  meeting: {
    topic: string;
    durationSec: number;
    teamParticipants: string[];
    clientParticipants: string[];
  };
}): Promise<{ outcome: VisionAnalysisOutcome; model: string }> {
  const { openai } = await import("../routes/middleware");
  const { QUALITY_MODEL } = await import("../aiModels");

  const { frames, meeting } = input;
  const teamList = meeting.teamParticipants.length > 0
    ? meeting.teamParticipants.join(", ")
    : "(unknown)";
  const clientList = meeting.clientParticipants.length > 0
    ? meeting.clientParticipants.join(", ")
    : "(none marked external — identify the client by elimination, or report client_visible=false if unsure)";

  const systemPrompt = [
    "You analyze frames sampled from a Zoom meeting recording between an agency team and their client.",
    "Your ONLY subject is the CLIENT's visible facial expression and body language — never the team members', and never the content of any shared screen.",
    "Identify which visible person is the client using the participant lists and any Zoom name labels visible on video tiles.",
    "BE CONSERVATIVE: if you cannot confidently identify a client face (camera off, screen-share-only frames, no name labels, ambiguous faces), set client_visible to false. Never guess or analyze the wrong person.",
    "Respond with ONLY a JSON object, no prose, matching exactly:",
    `{
  "client_visible": boolean,
  "client_identification": { "description": string, "confidence": "high" | "medium" | "low" },
  "overall": "positive" | "neutral" | "mixed" | "negative",
  "summary": string,
  "frames": [ { "frame": number, "client_visible": boolean, "sentiment": "positive" | "neutral" | "negative" | "unclear", "note": string } ],
  "notable_moments": [ { "frame": number, "note": string } ]
}`,
    "\"frames\" must have one entry per provided frame (1-based). \"notable_moments\" lists only frames showing something noteworthy (visible frustration, disengagement, enthusiasm, confusion). \"summary\" is 1-3 sentences on how the client appeared to feel across the meeting. When client_visible is false overall, omit overall/summary/frames/notable_moments.",
  ].join("\n");

  const content: any[] = [
    {
      type: "text",
      text: [
        `Meeting: "${meeting.topic}" — about ${Math.round(meeting.durationSec / 60)} minutes.`,
        `Team-side (internal) participants: ${teamList}.`,
        `Likely client-side participants: ${clientList}.`,
        `${frames.length} frames sampled at even intervals follow.`,
      ].join("\n"),
    },
  ];
  frames.forEach((f, i) => {
    content.push({
      type: "text",
      text: `Frame ${i + 1} — ${formatSentimentTimestamp(f.atSec)} into the meeting:`,
    });
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${fs.readFileSync(f.filePath).toString("base64")}`,
        detail: "auto",
      },
    });
  });

  // GPT-5 family: no temperature/top_p; budget via max_completion_tokens
  // (reasoning tokens count against it, so leave headroom). Vision over up
  // to 12 frames can exceed the shared client's 60s default timeout —
  // override per-request.
  const resp = await openai.chat.completions.create(
    {
      model: QUALITY_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 4000,
    },
    { timeout: 180_000, maxRetries: 1 },
  );

  const raw = resp.choices[0]?.message?.content ?? "";
  return {
    outcome: parseVisionOutcome(raw, frames.map((f) => f.atSec)),
    model: QUALITY_MODEL,
  };
}

export function defaultFaceSentimentDeps(): FaceSentimentDeps {
  return {
    fetchRecordingSet: defaultFetchRecordingSet,
    downloadVideo: defaultDownloadVideo,
    probeDurationSec: defaultProbeDurationSec,
    extractFrames: defaultExtractFrames,
    analyzeFrames: defaultAnalyzeFrames,
    now: () => new Date(),
  };
}

// ── Persistence ───────────────────────────────────────────────────────────

/**
 * Merge the result under the `zoomFaceSentiment` key with a jsonb `||` so a
 * concurrent writer of OTHER rawPayloadJson keys (transcript backfill etc.)
 * can't be clobbered by a read-modify-write race.
 */
async function persistFaceSentiment(
  recordId: string,
  result: ZoomFaceSentimentResult,
): Promise<void> {
  await withDbAttribution("zoom-face-sentiment:persist", async () => {
    await getDb().execute(sql`
      UPDATE raw_communication_records
      SET raw_payload_json = COALESCE(raw_payload_json, '{}'::jsonb)
            || jsonb_build_object('zoomFaceSentiment', ${JSON.stringify(result)}::jsonb),
          updated_at = NOW()
      WHERE id = ${recordId}
    `);
  });
}

// ── Enumeration ───────────────────────────────────────────────────────────

/**
 * Zoom records (within the lookback window) that still need a sentiment
 * outcome: no `zoomFaceSentiment` key yet, or a `failed` one with retry
 * budget left. `analyzed` / `no_video` / exhausted-`failed` are terminal
 * and never re-enter a batch. Newest meetings first — recent calls are the
 * actionable ones.
 */
export async function enumerateFaceSentimentCandidates(
  limit: number,
  opts?: { lookbackDays?: number },
): Promise<string[]> {
  const lookbackDays = opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  return withDbAttribution("zoom-face-sentiment:enumerate", async () => {
    const res: any = await getDb().execute(sql`
      SELECT id FROM raw_communication_records
      WHERE source_type = 'zoom'
        AND timestamp >= NOW() - make_interval(days => ${lookbackDays})
        AND (
          NOT (COALESCE(raw_payload_json, '{}'::jsonb) ? 'zoomFaceSentiment')
          OR (
            raw_payload_json->'zoomFaceSentiment'->>'status' = 'failed'
            AND COALESCE((raw_payload_json->'zoomFaceSentiment'->>'attempts')::int, 0)
                < ${ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS}
          )
        )
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `);
    const rows = Array.isArray(res) ? res : res?.rows ?? [];
    return rows.map((r: any) => String(r.id));
  });
}

// ── Sweep (producer) ──────────────────────────────────────────────────────

export interface FaceSentimentSweepSummary {
  skipped: boolean;
  reason?: string;
  candidates: number;
  enqueued: number;
}

export async function runZoomFaceSentimentSweep(opts?: {
  /** Test seam — defaults to the real feature-switch read. */
  isEnabled?: () => boolean;
  /** Test seam — defaults to the real durable enqueue. */
  enqueue?: (recordId: string) => Promise<unknown>;
  batchCap?: number;
  lookbackDays?: number;
}): Promise<FaceSentimentSweepSummary> {
  const enabled = (opts?.isEnabled ?? isZoomFaceSentimentEnabled)();
  if (!enabled) {
    return { skipped: true, reason: "disabled", candidates: 0, enqueued: 0 };
  }

  const batchCap = opts?.batchCap ?? (await readBatchCap());
  const lookbackDays = opts?.lookbackDays ?? (await readLookbackDays());
  const candidates = await enumerateFaceSentimentCandidates(batchCap, { lookbackDays });

  const enqueue =
    opts?.enqueue ??
    ((recordId: string) =>
      enqueueJob({
        queueName: ZOOM_FACE_SENTIMENT_ANALYZE_QUEUE,
        workloadClass: "maintenance",
        payload: { recordId },
        dedupeKey: `zoom_face_sentiment:${recordId}`,
        maxAttempts: 2,
      }));

  let enqueued = 0;
  for (const recordId of candidates) {
    await enqueue(recordId);
    enqueued++;
  }

  if (enqueued > 0) {
    console.log(`[ZoomFaceSentiment] Sweep enqueued ${enqueued} record(s) (cap ${batchCap}, lookback ${lookbackDays}d)`);
  }
  return { skipped: false, candidates: candidates.length, enqueued };
}

// ── Per-record processor ──────────────────────────────────────────────────

export type FaceSentimentOutcome =
  | "analyzed"
  | "no_video"
  | "failed"
  | "skipped_missing"
  | "skipped_not_zoom"
  | "skipped_terminal"
  | "skipped_exhausted"
  | "skipped_disabled";

function classifyRecordingFetchError(err: any): "permanent_auth" | "recording_gone" | "other" {
  if (err?.name === "ZoomPermanentError") return "permanent_auth";
  if (/\b(404|3001|3301)\b/.test(String(err?.message ?? ""))) return "recording_gone";
  return "other";
}

/** Prefer views most likely to show the client's face tile. */
export function pickBestMp4(recordingFiles: any[]): any | null {
  const mp4s = (recordingFiles || []).filter(
    (f: any) => f?.file_type === "MP4" && f?.download_url,
  );
  if (mp4s.length === 0) return null;
  const preference = [
    "gallery_view",
    "active_speaker",
    "speaker_view",
    "shared_screen_with_gallery_view",
    "shared_screen_with_speaker_view",
  ];
  for (const type of preference) {
    const hit = mp4s.find((f: any) => f?.recording_type === type);
    if (hit) return hit;
  }
  return mp4s[0];
}

export async function processZoomFaceSentimentRecord(
  recordId: string,
  deps: FaceSentimentDeps = defaultFaceSentimentDeps(),
  opts?: { isEnabled?: () => boolean },
): Promise<FaceSentimentOutcome> {
  // Re-check the gate at execution time — the job may have been enqueued
  // before an operator flipped the switch off.
  const enabled = (opts?.isEnabled ?? isZoomFaceSentimentEnabled)();
  if (!enabled) return "skipped_disabled";

  const record = await withDbAttribution("zoom-face-sentiment:load", async () => {
    const res: any = await getDb().execute(sql`
      SELECT id, source_type, title, participants_json, raw_payload_json
      FROM raw_communication_records
      WHERE id = ${recordId}
      LIMIT 1
    `);
    const rows = Array.isArray(res) ? res : res?.rows ?? [];
    return rows[0] ?? null;
  });

  if (!record) return "skipped_missing";
  if (record.source_type !== "zoom") return "skipped_not_zoom";

  const payload = (record.raw_payload_json as any) || {};
  const existing = payload.zoomFaceSentiment as Partial<ZoomFaceSentimentResult> | undefined;

  // Idempotency: terminal outcomes never re-run; exhausted failures park.
  if (existing?.status === "analyzed" || existing?.status === "no_video") {
    return "skipped_terminal";
  }
  const priorAttempts = existing?.status === "failed" ? (existing.attempts ?? 0) : 0;
  if (existing?.status === "failed" && priorAttempts >= ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS) {
    return "skipped_exhausted";
  }

  const nowIso = () => deps.now().toISOString();
  const base = { version: ZOOM_FACE_SENTIMENT_VERSION };

  const storeNoVideo = async (
    reason: ZoomFaceSentimentNoVideoReason,
    extra?: Partial<ZoomFaceSentimentResult>,
  ): Promise<FaceSentimentOutcome> => {
    await persistFaceSentiment(recordId, {
      ...base,
      status: "no_video",
      reason,
      at: nowIso(),
      ...extra,
    });
    console.log(`[ZoomFaceSentiment] Record ${recordId}: no video to analyze (${reason})`);
    return "no_video";
  };

  const storeFailed = async (
    error: string,
    opts2?: { consumeAttempt?: boolean },
  ): Promise<FaceSentimentOutcome> => {
    const consume = opts2?.consumeAttempt !== false;
    await persistFaceSentiment(recordId, {
      ...base,
      status: "failed",
      error: error.slice(0, 500),
      attempts: consume ? priorAttempts + 1 : priorAttempts,
      at: nowIso(),
    });
    console.warn(`[ZoomFaceSentiment] Record ${recordId} failed: ${error.slice(0, 200)}`);
    return "failed";
  };

  // Zero recording files known at ingest → explicit no-video without an API
  // call (also covers `zoom_meeting` rows that never had cloud recordings).
  const recordingCount = Number(payload.recordingCount ?? 0);
  if (!Number.isFinite(recordingCount) || recordingCount <= 0) {
    return storeNoVideo("no_video_file", {
      detail: "Zoom reported no recording files for this meeting at ingest.",
    });
  }

  const meetingUuid = payload.meetingUuid || payload.meetingId?.toString();
  if (!meetingUuid) {
    // Unfixable — no identifier to look the recording up with. Park it
    // (consume the whole budget) so the sweep stops retrying.
    await persistFaceSentiment(recordId, {
      ...base,
      status: "failed",
      error: "record has no meetingUuid/meetingId to look up the recording",
      attempts: ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS,
      at: nowIso(),
    });
    return "failed";
  }

  // Live recording-set lookup (rawPayloadJson stores only a summary).
  let recordingSet: any;
  try {
    recordingSet = await deps.fetchRecordingSet(String(meetingUuid));
  } catch (err: any) {
    const kind = classifyRecordingFetchError(err);
    if (kind === "recording_gone") {
      return storeNoVideo("recording_unavailable", {
        detail: "Zoom no longer has this recording (deleted, trashed, or expired).",
      });
    }
    // Auth/scope-gate failures don't consume an attempt: no analysis is
    // possible integration-wide until an operator reconnects, and burning
    // the per-record budget during the outage would park everything.
    return storeFailed(
      kind === "permanent_auth"
        ? `zoom auth/scope failure — operator reconnect required (${String(err?.message ?? err).slice(0, 200)})`
        : String(err?.message ?? err),
      { consumeAttempt: kind !== "permanent_auth" },
    );
  }

  const files: any[] = recordingSet?.recording_files || [];
  const mp4 = pickBestMp4(files);
  if (!mp4) {
    const fileTypes = Array.from(
      new Set(
        files
          .map((f: any) => (typeof f?.file_type === "string" ? f.file_type : null))
          .filter((t: string | null): t is string => !!t),
      ),
    );
    return storeNoVideo("no_video_file", { fileTypes });
  }

  // Download → probe → sample → analyze. All failures below are persisted
  // as reviewable `failed` outcomes (never thrown) — retried on the sweep
  // cadence until the attempt budget runs out.
  const tmpDir = path.join(os.tmpdir(), `zoom-sentiment-${recordId}`);
  const videoPath = path.join(tmpDir, "recording.mp4");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      await deps.downloadVideo(mp4.download_url, videoPath);
    } catch (err: any) {
      return await storeFailed(`video download failed: ${err?.message ?? err}`);
    }

    const ingestDurationSec = Number(payload.duration ?? 0) * 60;
    const durationSec =
      (await deps.probeDurationSec(videoPath)) ??
      (Number.isFinite(ingestDurationSec) && ingestDurationSec > 0 ? ingestDurationSec : null);
    if (!durationSec) {
      return await storeFailed("could not determine video duration (ffprobe + ingest metadata both empty)");
    }

    const timestamps = planSampleTimestamps(durationSec);
    const frames = await deps.extractFrames(videoPath, timestamps, path.join(tmpDir, "frames"));
    if (frames.length === 0) {
      return await storeFailed("frame extraction produced no frames");
    }

    const participants: any[] = Array.isArray(record.participants_json)
      ? record.participants_json
      : [];
    const teamParticipants = participants
      .filter((p) => p?.role === "participant" || p?.role === "host")
      .map((p) => String(p?.name || p?.email || "")).filter(Boolean);
    const clientParticipants = participants
      .filter((p) => p?.role === "external")
      .map((p) => String(p?.name || p?.email || "")).filter(Boolean);

    let outcome: VisionAnalysisOutcome;
    let model: string;
    try {
      const analyzed = await deps.analyzeFrames({
        frames,
        meeting: {
          topic: String(record.title ?? "Zoom meeting"),
          durationSec,
          teamParticipants,
          clientParticipants,
        },
      });
      outcome = analyzed.outcome;
      model = analyzed.model;
    } catch (err: any) {
      return await storeFailed(`vision analysis failed: ${err?.message ?? err}`);
    }

    if (!outcome.clientVisible) {
      // Conservative fallback: an explicit no-video outcome, never a bogus
      // reading of an empty tile / shared screen / the wrong person.
      return await storeNoVideo("client_not_visible", {
        detail: outcome.clientIdentification.description || undefined,
        framesSampled: frames.length,
        model,
      });
    }

    await persistFaceSentiment(recordId, {
      ...base,
      status: "analyzed",
      at: nowIso(),
      overall: outcome.overall,
      summary: outcome.summary,
      timeline: outcome.timeline ?? [],
      notableMoments: outcome.notableMoments ?? [],
      clientIdentification: outcome.clientIdentification,
      framesSampled: frames.length,
      framesWithClientVisible: outcome.framesWithClientVisible ?? 0,
      model,
    });
    console.log(
      `[ZoomFaceSentiment] Analyzed "${record.title}" (${recordId}): ${outcome.overall}, ${frames.length} frames`,
    );
    return "analyzed";
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort tmp cleanup
    }
  }
}

// ── Queue handlers + scheduler ────────────────────────────────────────────

export async function handleZoomFaceSentimentSweep(
  _job: WorkQueueJob,
): Promise<{ cursor?: string } | void> {
  const summary = await runZoomFaceSentimentSweep();
  if (summary.skipped) {
    return { cursor: `skipped:${summary.reason}` };
  }
}

export async function handleZoomFaceSentimentAnalyze(
  job: WorkQueueJob,
): Promise<{ cursor?: string } | void> {
  const payload = (job.payload ?? {}) as { recordId?: string };
  if (!payload.recordId || typeof payload.recordId !== "string") {
    console.warn("[ZoomFaceSentiment] analyze job missing recordId — completing as no-op");
    return { cursor: "skipped:no_record_id" };
  }
  const outcome = await processZoomFaceSentimentRecord(payload.recordId);
  return { cursor: outcome };
}

export function registerZoomFaceSentimentHandlers(): void {
  registerHandler(ZOOM_FACE_SENTIMENT_SWEEP_QUEUE, handleZoomFaceSentimentSweep);
  registerHandler(ZOOM_FACE_SENTIMENT_ANALYZE_QUEUE, handleZoomFaceSentimentAnalyze);
}

let scheduler: ReturnType<typeof setInterval> | null = null;

export function startZoomFaceSentimentScheduler(): void {
  if (scheduler) return;
  const tick = async () => {
    try {
      // Cheap pre-check so a disabled feature doesn't even enqueue sweep
      // jobs; the sweep handler re-checks for jobs already in flight.
      if (!isZoomFaceSentimentEnabled()) return;
      await enqueueJob({
        queueName: ZOOM_FACE_SENTIMENT_SWEEP_QUEUE,
        workloadClass: "maintenance",
        dedupeKey: "zoom_face_sentiment_sweep:tick",
        payload: { kind: "scheduled" },
      });
    } catch (err: any) {
      console.warn("[ZoomFaceSentiment] sweep enqueue tick failed:", err?.message || err);
    }
  };
  void tick();
  scheduler = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
}

export function stopZoomFaceSentimentScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
}
