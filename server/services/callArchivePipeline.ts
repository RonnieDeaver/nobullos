// @cross-instance-safe: work_queue poller — claims rows with FOR UPDATE SKIP LOCKED; parallel polling across instances is intended.
// Call recording archive pipeline.
//
// For every Twilio call with a finished recording, this module:
//   1. Streams the .mp3 from Twilio's media server into our private
//      object storage (deterministic key per call id, idempotent).
//   2. Transcribes the audio with OpenAI's gpt-4o-mini-transcribe and
//      stores the text on the twilio_calls row (transcript_text).
//   3. Delivers recording.mp3 + transcript.txt to the matched client's
//      in-app files ("Call Recordings"/"Call Transcripts" folders under
//      the client's Files tab) — the canonical home (Task #4025). The
//      legacy Google Drive mirror was retired by Task #4084; unmatched
//      calls (no client) have no in-app home and stay in object storage
//      (their drive_* columns are legacy read-only history).
//   4. After object storage is confirmed, schedules the Twilio recording
//      to be deleted from Twilio's servers after a 7-day safety window
//      via sweepTwilioDeletions().
//
// All steps are idempotent: re-running picks up where a prior attempt
// failed, guarded by the columns added in migration 0041.

import { workerDb as db, dbRetry, withDbAttribution } from "../db";
import { twilioCalls, type TwilioCall } from "@shared/schema";
import { and, asc, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { storage } from "../storage";
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";
import { auditedDownload } from "../replit_integrations/object_storage/audit";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import { createDefaultOpenAiClient, DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS } from "./ai/openAiClient";
import { getTwilioConfig } from "./twilioService";
import { workerLog } from "./workerLogger";
import { getMaxProcessingMs } from "./queueMaxProcessing";
// Workers/queues parity (E-F05): operator kill switch for the archive
// pipeline — checked before every claim so a stop takes effect at the
// next row boundary without failing in-flight work.
import { isKillSwitchEnabled } from "./killSwitches";

// ---------------------------------------------------------------------------
// Constants & tuning
// ---------------------------------------------------------------------------

const TWILIO_DELETE_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Exported so the Task #1053 health watcher (`callArchiveBacklogAlerts`)
// can detect rows that have exhausted the bounded retry budget without
// duplicating the constant.
export const MAX_ATTEMPTS = 6;
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes — long enough for a slow transcription
// Task #1055: pipeline name used to look up the per-queue max-processing
// ceiling (see queueMaxProcessing.ts). Mirrors the Task #1048 pattern that
// caps total processing time so a hung handler whose heartbeat keeps firing
// can no longer extend its lease forever.
const CALL_ARCHIVE_QUEUE_NAME = "call_archive";

const objectStorageService = new ObjectStorageService();

const openai = createDefaultOpenAiClient();

export function getRecordingObjectKey(callId: string): string {
  return `twilio_calls/${callId}/recording.mp3`;
}

export function getTranscriptObjectKey(callId: string): string {
  return `twilio_calls/${callId}/transcript.txt`;
}

function backoffMs(attempts: number): number {
  // 1m, 5m, 15m, 30m, 1h, 2h
  const ladder = [60, 300, 900, 1800, 3600, 7200];
  const idx = Math.min(Math.max(attempts - 1, 0), ladder.length - 1);
  return ladder[idx] * 1000;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// Called from the recording-status webhook when RecordingStatus="completed"
// arrives. Idempotent: a row already in queued/processing/done is left alone.
//
// Task #1046: when transitioning a row out of `failed` (the terminal state
// the pipeline lands in after MAX_ATTEMPTS exhausted retries), reset
// `archive_attempts` back to 0. Otherwise the very next claim would
// re-fail the row immediately because `claim_attempts + 1 > MAX_ATTEMPTS`
// would still be true. A late recording-status webhook is a fresh signal
// — the row deserves a fresh retry budget.
export async function enqueueCallArchive(callId: string): Promise<void> {
  await dbRetry(async () => {
    await db.update(twilioCalls)
      .set({
        archiveStatus: "queued",
        archiveAttempts: 0,
        archiveLastError: null,
        archiveFailureReason: null,
        archiveLockedUntil: null,
        archiveNextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(twilioCalls.id, callId),
        // Only push back to queued from terminal-failure or pending states.
        // Don't bump rows already in flight (processing) or finished (done/skipped).
        or(
          isNull(twilioCalls.archiveStatus),
          eq(twilioCalls.archiveStatus, "pending"),
          eq(twilioCalls.archiveStatus, "failed"),
        )!,
      ));
  });
}

// Marks a call as 'skipped' — no recording will arrive (e.g. Recording
// disabled or status='absent').
export async function markCallArchiveSkipped(callId: string, reason: string): Promise<void> {
  await dbRetry(async () => {
    await db.update(twilioCalls)
      .set({
        archiveStatus: "skipped",
        archiveLastError: reason,
        updatedAt: new Date(),
      })
      .where(eq(twilioCalls.id, callId));
  });
}

// Single-flight guard for the worker tick. The scheduler runs every
// 30s; if a previous tick is still running (slow OpenAI),
// later ticks must NOT start a parallel batch — otherwise two ticks
// could each claim the same row in succession after the lock TTL
// expires, doubling OpenAI work.
let batchInFlight = false;

// E-F05: log the pre-batch kill-switch skip once per ON transition.
let killSwitchGateLogged = false;

// Heartbeat interval. While processing a single call, periodically
// extend archive_locked_until so a long-running job is not eligible for
// re-claim by another process.
const HEARTBEAT_MS = 60 * 1000;

// Worker tick: claim up to N rows ready for processing and process them
// sequentially. Concurrency is intentionally low so we don't overrun
// OpenAI rate limits.
export async function processNextBatch(maxBatch = 3): Promise<{ processed: number; errors: number }> {
  if (batchInFlight) {
    workerLog({
      worker: "callArchivePipeline",
      event: "worker_skipped_overlap",
      queueName: CALL_ARCHIVE_QUEUE_NAME,
      detail: "previous batch still in flight",
    });
    return { processed: 0, errors: 0 };
  }
  batchInFlight = true;
  let processed = 0;
  let errors = 0;
  try {
    for (let i = 0; i < maxBatch; i++) {
      // E-F05: operator kill switch — checked before EVERY claim so a
      // mid-batch stop takes effect at the next row boundary. The pre-batch
      // skip (i === 0) is logged once per ON transition (the tick fires
      // every 30s — logging every skipped tick would be noise); a genuine
      // mid-batch stop is always logged.
      if (isKillSwitchEnabled("call_archive")) {
        if (i > 0 || !killSwitchGateLogged) {
          killSwitchGateLogged = true;
          workerLog({
            worker: "callArchivePipeline",
            event: "kill_switch_abort",
            killSwitch: "call_archive",
            queueName: CALL_ARCHIVE_QUEUE_NAME,
            detail: i > 0
              ? `operator stop honored mid-batch after ${i} row(s) - in-flight work completed normally`
              : "tick skipped - operator kill switch enabled (logged once per transition)",
          });
        }
        break;
      }
      killSwitchGateLogged = false;
      const result = await claimNextCall();
      if (result.kind === "empty") break;
      // Task #1046: a row that hit MAX_ATTEMPTS is now marked `failed`
      // by the claim. Don't break the batch on it — keep claiming so a
      // single ceiling-hit row doesn't block other eligible rows in
      // this tick.
      if (result.kind === "exceeded") continue;
      const claimed = result.call;
      // Task #1055: capture the lease epoch at claim time so the
      // heartbeat can enforce a hard ceiling on total processing time
      // and so terminal writes can be lease-guarded against a stale,
      // overrun handler clobbering a row that was already reclaimed.
      // `archive_attempts` is bumped by the claim SQL on every reclaim,
      // so it is the natural per-attempt epoch.
      const claimedAttempts = claimed.archiveAttempts ?? 0;
      const claimedAtMs = Date.now();
      let leaseRevoked = false;
      let heartbeat: NodeJS.Timeout | undefined;
      const tickHeartbeat = async () => {
        if (leaseRevoked) return;
        try {
          const maxProcessingMs = await getMaxProcessingMs(CALL_ARCHIVE_QUEUE_NAME);
          const elapsedMs = Date.now() - claimedAtMs;
          if (elapsedMs >= maxProcessingMs) {
            // Release the lock immediately so the next claim tick can
            // reclaim and retry (claim SQL bumps archive_attempts and
            // marks `failed` once MAX_ATTEMPTS is exceeded). Lease-guard
            // the release with the captured attempts epoch so we don't
            // race with a reclaim that already happened.
            leaseRevoked = true;
            // Stop the timer immediately so we don't keep firing
            // no-op ticks for the remainder of the (possibly long)
            // handler lifetime.
            if (heartbeat) clearInterval(heartbeat);
            await db.update(twilioCalls)
              .set({ archiveLockedUntil: new Date() })
              .where(and(
                eq(twilioCalls.id, claimed.id),
                eq(twilioCalls.archiveAttempts, claimedAttempts),
              ));
            workerLog({
              worker: "callArchivePipeline",
              event: "max_processing_exceeded",
              jobId: claimed.id,
              queueName: CALL_ARCHIVE_QUEUE_NAME,
              elapsedMs,
              maxProcessingMs,
              attempts: claimedAttempts,
            });
            return;
          }
          await db.update(twilioCalls)
            .set({ archiveLockedUntil: new Date(Date.now() + LOCK_TTL_MS) })
            .where(and(
              eq(twilioCalls.id, claimed.id),
              eq(twilioCalls.archiveAttempts, claimedAttempts),
            ));
        } catch (err: any) {
          console.warn("[CallArchive] Heartbeat lock-extend failed", { callId: claimed.id, error: err?.message });
        }
      };
      heartbeat = setInterval(() => { void tickHeartbeat(); }, HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        await processCallArchive(claimed.id, claimedAttempts);
        if (!leaseRevoked) processed++;
      } catch (err: any) {
        if (!leaseRevoked) {
          errors++;
          console.error("[CallArchive] Process failed", { callId: claimed.id, error: err?.message });
          await recordFailure(claimed.id, err, claimedAttempts);
        } else {
          // Handler threw after we revoked the lease for max-processing
          // overrun. The row will be reclaimed on the next tick; do not
          // double-count and do not clobber the reclaimed row's state.
          console.warn("[CallArchive] Handler threw after lease revoked (max_processing_exceeded), suppressing failure write", {
            callId: claimed.id,
            error: err?.message,
          });
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    batchInFlight = false;
  }
  return { processed, errors };
}

type ClaimResult =
  | { kind: "claimed"; call: TwilioCall }
  | { kind: "exceeded" }
  | { kind: "empty" };

async function claimNextCall(): Promise<ClaimResult> {
  // Atomic claim: SET archive_status='processing', bump archive_attempts,
  // and set archive_locked_until=now+ttl for the oldest eligible row not
  // currently locked. Postgres FOR UPDATE SKIP LOCKED inside an
  // UPDATE..FROM (SELECT...) avoids racing other workers if we ever
  // scale beyond one process.
  //
  // Eligibility (Task #1046): any non-terminal row (`pending`, `queued`,
  // or a stale `processing` whose lock has expired) whose
  // `archive_next_attempt_at` is null or due. We deliberately do NOT
  // gate on `recording_status='completed'` / `recording_url IS NOT NULL`
  // here — gating in the claim query left rows whose recording-status
  // webhook never fired stuck in `pending` forever (the bug this task
  // fixes). When recording metadata is missing at process time,
  // `processCallArchive` throws so the row routes through bounded
  // backoff via `recordFailure`, and a late recording-status webhook
  // can recover it through `enqueueCallArchive` (which also resets
  // `archive_attempts` so the freshly-enqueued row gets a real chance).
  // Rows whose attempts have already exceeded the bounded retry budget
  // are marked `failed` here instead of claimed for processing — that
  // keeps the unclaimable / stuck-row case from looping.
  const now = new Date();
  const lockUntil = new Date(now.getTime() + LOCK_TTL_MS);
  const rows = await dbRetry(async () => db.execute(sql`
    UPDATE twilio_calls
    SET archive_status = CASE
          WHEN COALESCE(archive_attempts, 0) + 1 > ${MAX_ATTEMPTS} THEN 'failed'
          ELSE 'processing'
        END,
        archive_attempts = COALESCE(archive_attempts, 0) + 1,
        archive_locked_until = CASE
          WHEN COALESCE(archive_attempts, 0) + 1 > ${MAX_ATTEMPTS} THEN NULL
          ELSE ${lockUntil}::timestamp
        END,
        -- Task #1099: set lease epoch only when the row actually
        -- transitions into 'processing'. The heartbeat NEVER touches
        -- this column, so NOW() - archive_leased_at is the true
        -- time-since-claim for stuck-processing inventory. Rows that
        -- hit MAX_ATTEMPTS and route to 'failed' here are not "leased",
        -- so leave the column null for them.
        archive_leased_at = CASE
          WHEN COALESCE(archive_attempts, 0) + 1 > ${MAX_ATTEMPTS} THEN NULL
          ELSE ${now}::timestamp
        END,
        archive_last_error = CASE
          WHEN COALESCE(archive_attempts, 0) + 1 > ${MAX_ATTEMPTS}
            THEN COALESCE(archive_last_error, 'max attempts exceeded')
          ELSE archive_last_error
        END,
        updated_at = ${now}
    WHERE id = (
      SELECT id FROM twilio_calls
      WHERE archive_status NOT IN ('done', 'failed', 'skipped')
        AND archive_status IS NOT NULL
        AND (archive_locked_until IS NULL OR archive_locked_until < ${now})
        AND (archive_next_attempt_at IS NULL OR archive_next_attempt_at <= ${now})
      ORDER BY COALESCE(archive_next_attempt_at, created_at) ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `));
  const row = (rows.rows || [])[0] as any;
  if (!row) return { kind: "empty" };
  const call = rowToCall(row);
  if (call.archiveStatus === "failed") {
    // Hit the retry ceiling on this claim — log and signal the batch
    // loop to continue to the next eligible row (don't break out).
    console.warn("[CallArchive] Row exceeded MAX_ATTEMPTS, marked failed", {
      callId: call.id,
      attempts: call.archiveAttempts,
    });
    return { kind: "exceeded" };
  }
  console.log("[CallArchive] claimed", {
    callId: call.id,
    attempts: call.archiveAttempts,
    recordingStatus: call.recordingStatus,
    hasRecordingUrl: !!call.recordingUrl,
  });
  return { kind: "claimed", call };
}

function rowToCall(row: any): TwilioCall {
  // Drizzle's raw execute returns snake_case keys; map to the camelCase
  // TwilioCall shape so downstream code can use field names consistently.
  return {
    id: row.id,
    clientId: row.client_id,
    clientContactId: row.client_contact_id,
    twilioSid: row.twilio_sid,
    direction: row.direction,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    status: row.status,
    duration: row.duration,
    initiatedByUserId: row.initiated_by_user_id,
    routedToUserId: row.routed_to_user_id,
    routingTier: row.routing_tier,
    answeredAt: row.answered_at,
    rawCommunicationRecordId: row.raw_communication_record_id,
    recordingSid: row.recording_sid,
    recordingUrl: row.recording_url,
    recordingDuration: row.recording_duration,
    recordingStatus: row.recording_status,
    recordingChannels: row.recording_channels,
    archiveStatus: row.archive_status,
    archiveAttempts: row.archive_attempts,
    archiveLastError: row.archive_last_error,
    archiveLockedUntil: row.archive_locked_until,
    archiveNextAttemptAt: row.archive_next_attempt_at,
    archiveLeasedAt: row.archive_leased_at,
    objectStorageKey: row.object_storage_key,
    objectStorageArchivedAt: row.object_storage_archived_at,
    transcriptText: row.transcript_text,
    transcriptCompletedAt: row.transcript_completed_at,
    transcriptError: row.transcript_error,
    driveRecordingFileId: row.drive_recording_file_id,
    driveRecordingFolderId: row.drive_recording_folder_id,
    driveRecordingWebLink: row.drive_recording_web_link,
    driveRecordingUploadedAt: row.drive_recording_uploaded_at,
    driveTranscriptFileId: row.drive_transcript_file_id,
    driveTranscriptFolderId: row.drive_transcript_folder_id,
    driveTranscriptWebLink: row.drive_transcript_web_link,
    driveTranscriptUploadedAt: row.drive_transcript_uploaded_at,
    twilioDeleteEligibleAt: row.twilio_delete_eligible_at,
    twilioRecordingDeletedAt: row.twilio_recording_deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as TwilioCall;
}

// Process a single call through every pending phase. Each phase checks
// the row's existing columns and skips if already done.
//
// Task #1055: `expectedAttempts` is the per-attempt lease epoch captured
// at claim time. When provided, the terminal "done" write is gated on
// `archive_attempts = expectedAttempts` so a stale, overrun handler
// can't clobber a row that was already reclaimed by a fresh attempt.
// Omit (manual / one-off invocation) to skip the guard.
export async function processCallArchive(callId: string, expectedAttempts?: number): Promise<void> {
  const [call] = await db.select().from(twilioCalls).where(eq(twilioCalls.id, callId));
  if (!call) return;
  // Task #1046: when claimed without recording metadata, the
  // recording-status webhook may simply be slow to arrive (or may have
  // failed and be retrying). Don't permanently mark the row `skipped`
  // here — that would put it into a state `enqueueCallArchive` cannot
  // recover from when the webhook eventually does land. Instead throw,
  // which routes through `recordFailure` → bounded backoff (1m, 5m,
  // 15m, 30m, 1h, 2h) and finally `failed` after MAX_ATTEMPTS.
  // `failed` is recoverable: a late webhook will set status='queued'
  // via enqueueCallArchive and the pipeline picks the row back up.
  if (!call.recordingUrl || call.recordingStatus !== "completed") {
    throw new Error(
      `recording metadata not yet present (recording_status=${call.recordingStatus || "null"}, has_url=${!!call.recordingUrl})`,
    );
  }

  // Phase 1: object storage. Source of truth.
  if (!call.objectStorageArchivedAt || !call.objectStorageKey) {
    await uploadRecordingToObjectStorage(call);
  }

  // Phase 2: transcription. Independent of Drive; failures here don't
  // block the rest of the pipeline (text just stays null).
  const refreshed1 = await refreshCall(callId);
  // Transcription is retryable: a previous error does NOT permanently
  // disqualify the call. Each pipeline run that finds objectStorageKey
  // set and transcript not yet completed will try again. The error
  // column is overwritten with the latest message; success clears it.
  if (refreshed1 && refreshed1.objectStorageKey && !refreshed1.transcriptCompletedAt) {
    try {
      await transcribeRecording(refreshed1);
    } catch (err: any) {
      console.warn("[CallArchive] Transcription failed (non-fatal, will retry)", { callId, error: err?.message });
      await db.update(twilioCalls)
        .set({ transcriptError: String(err?.message || err).slice(0, 500), updatedAt: new Date() })
        .where(eq(twilioCalls.id, callId));
    }
  }

  // Phase 3: in-app client-file delivery (Task #4025; the legacy Drive
  // mirror was retired by Task #4084). Matched clients only — unmatched
  // calls have no in-app home; object storage stays the source of truth.
  // Failures throw → recordFailure → bounded backoff retry.
  const refreshed2 = await refreshCall(callId);
  if (refreshed2?.clientId) {
    if (
      !refreshed2.clientFileRecordingSavedAt ||
      (!refreshed2.clientFileTranscriptSavedAt && refreshed2.transcriptText)
    ) {
      await saveToClientFiles(refreshed2);
    }
  }

  // Mark done. Twilio delete eligibility is set in phase 1; object
  // storage is the source of truth.
  // Task #1055: lease-guard the terminal "done" write with the captured
  // attempts epoch so a stale, overrun handler whose lease was revoked
  // by the heartbeat cap cannot clobber a row that has since been
  // reclaimed and reattempted.
  const doneWhere = expectedAttempts !== undefined
    ? and(eq(twilioCalls.id, callId), eq(twilioCalls.archiveAttempts, expectedAttempts))!
    : eq(twilioCalls.id, callId);
  const updated = await db.update(twilioCalls)
    .set({
      archiveStatus: "done",
      archiveLockedUntil: null,
      archiveLastError: null,
      archiveFailureReason: null,
      updatedAt: new Date(),
    })
    .where(doneWhere)
    .returning({ id: twilioCalls.id });
  if (expectedAttempts !== undefined && updated.length === 0) {
    workerLog({
      worker: "callArchivePipeline",
      event: "job_completion_stale_lease_ignored",
      jobId: callId,
      queueName: CALL_ARCHIVE_QUEUE_NAME,
      attempts: expectedAttempts,
      outcome: "completed",
    });
  }
}

async function refreshCall(callId: string): Promise<TwilioCall | undefined> {
  const [row] = await db.select().from(twilioCalls).where(eq(twilioCalls.id, callId));
  return row;
}

// ---------------------------------------------------------------------------
// Phase 1: download from Twilio → private object storage
// ---------------------------------------------------------------------------
async function uploadRecordingToObjectStorage(call: TwilioCall): Promise<void> {
  if (!call.recordingUrl) throw new Error("recordingUrl missing");
  const cfg = await getTwilioConfig();
  if (!cfg) throw new Error("Twilio not configured");

  // SSRF guard mirrors the audio proxy: only fetch from twilio.com hosts.
  const parsed = new URL(call.recordingUrl);
  if (!parsed.hostname.endsWith(".twilio.com")) {
    throw new Error(`Refusing to fetch recording from non-Twilio host: ${parsed.hostname}`);
  }

  const url = call.recordingUrl.endsWith(".mp3") ? call.recordingUrl : `${call.recordingUrl}.mp3`;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const upstream = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Twilio recording fetch failed: ${upstream.status}`);
  }

  const objectKey = getRecordingObjectKey(call.id);
  const nodeStream = Readable.fromWeb(upstream.body as any);
  const result = await objectStorageService.streamUploadToPrivateKey(
    objectKey,
    nodeStream,
    upstream.headers.get("content-type") || "audio/mpeg",
  );

  const now = new Date();
  await db.update(twilioCalls)
    .set({
      objectStorageKey: result.objectKey,
      objectStorageArchivedAt: now,
      // Set the deletion timer the first time we successfully archive.
      // We use COALESCE in SQL so a re-archive (e.g. after manual reset)
      // doesn't push the deletion further out.
      twilioDeleteEligibleAt: sql`COALESCE(${twilioCalls.twilioDeleteEligibleAt}, ${new Date(now.getTime() + TWILIO_DELETE_DELAY_MS)})`,
      updatedAt: now,
    })
    .where(eq(twilioCalls.id, call.id));

  console.log("[CallArchive] Object storage upload complete", { callId: call.id, objectKey, size: result.size });
}

// ---------------------------------------------------------------------------
// Phase 2: transcription
// ---------------------------------------------------------------------------
async function transcribeRecording(call: TwilioCall): Promise<void> {
  if (!call.objectStorageKey) throw new Error("objectStorageKey missing");
  const file = await objectStorageService.getPrivateObjectFileByKey(call.objectStorageKey);
  const tempPath = path.join(os.tmpdir(), `twilio_${call.id}_${randomUUID()}.mp3`);
  try {
    await auditedDownload(file, { destination: tempPath });
    const buffer = await fs.promises.readFile(tempPath);
    const audioFile = new File([buffer], "recording.mp3", { type: "audio/mpeg" });
    const response = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: audioFile as any,
      response_format: "json",
    }, { timeout: DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS });
    const text = (response.text || "").trim();
    await db.update(twilioCalls)
      .set({
        transcriptText: text,
        transcriptCompletedAt: new Date(),
        transcriptError: null,
        updatedAt: new Date(),
      })
      .where(eq(twilioCalls.id, call.id));
    console.log("[CallArchive] Transcription complete", { callId: call.id, chars: text.length });
  } finally {
    await fs.promises.unlink(tempPath).catch(() => undefined);
  }
}

function callBaseFileName(call: TwilioCall): string {
  const ts = call.createdAt instanceof Date ? call.createdAt : new Date(call.createdAt as any);
  const dateStr = ts.toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const direction = call.direction === "inbound" ? "in" : "out";
  const counterparty = (call.direction === "inbound" ? call.fromNumber : call.toNumber) || "unknown";
  const safeCounter = counterparty.replace(/[^0-9+]/g, "");
  return `${dateStr}_${direction}_${safeCounter}_${call.id.slice(0, 8)}`;
}

// Task #4025 — in-app client-file delivery (the canonical home).
// Per-sink idempotency via the client_file_*_saved_at columns plus a
// reuse-by-name check inside storeClientFile, so a partial failure never
// duplicates content. Matched
// clients only — callers gate on call.clientId. Exported for the delivery
// test suite (tests/client-file-delivery.test.ts).
export async function saveToClientFiles(call: TwilioCall): Promise<void> {
  const { ensureClientFileFolderPath, storeClientFile, CALL_RECORDINGS_FOLDER, CALL_TRANSCRIPTS_FOLDER } =
    await import("./clientFileDelivery");
  const clientId = call.clientId!;
  const actor = { id: null, name: "Call archive" };
  const baseName = callBaseFileName(call);

  if (!call.clientFileRecordingSavedAt) {
    if (!call.objectStorageKey) throw new Error("objectStorageKey missing for client-file save");
    const folder = await ensureClientFileFolderPath(clientId, [CALL_RECORDINGS_FOLDER], actor);
    const { file, reused } = await storeClientFile({
      clientId,
      folderId: folder.id,
      fileName: `${baseName}.mp3`,
      content: () => objectStorageService.createPrivateObjectReadStream(call.objectStorageKey!),
      contentType: "audio/mpeg",
      actor,
    });
    await db.update(twilioCalls)
      .set({
        clientFileRecordingId: file.id,
        clientFileRecordingSavedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(twilioCalls.id, call.id));
    console.log("[CallArchive] Client-file recording saved", { callId: call.id, fileId: file.id, reused });
  }

  if (!call.clientFileTranscriptSavedAt && call.transcriptText) {
    const folder = await ensureClientFileFolderPath(clientId, [CALL_TRANSCRIPTS_FOLDER], actor);
    const { file, reused } = await storeClientFile({
      clientId,
      folderId: folder.id,
      fileName: `${baseName}.txt`,
      content: Buffer.from(call.transcriptText, "utf8"),
      contentType: "text/plain",
      actor,
    });
    await db.update(twilioCalls)
      .set({
        clientFileTranscriptId: file.id,
        clientFileTranscriptSavedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(twilioCalls.id, call.id));
    console.log("[CallArchive] Client-file transcript saved", { callId: call.id, fileId: file.id, reused });
  }
}

// ---------------------------------------------------------------------------
// Failure / retry tracking
// ---------------------------------------------------------------------------

// Workers/queues parity (E-F12): machine-readable failure classification
// stored in `archive_failure_reason` alongside the free-text
// `archive_last_error` (which stays authoritative for humans). Heuristic
// message-based mapping over the pipeline's failure surfaces — same
// approach as `classifyError` in semrushLocationSyncState. Falls back to
// "unknown" rather than guessing.
export type ArchiveFailureReason =
  | "twilio_fetch_failed"
  | "object_storage_failed"
  | "transcription_failed"
  // "drive_failed" retired with the Drive mirror (Task #4084) — legacy rows
  // in archive_failure_reason may still carry it.
  | "client_files_failed"
  | "config_missing"
  | "timeout"
  | "db_error"
  | "unknown";

export function classifyArchiveFailure(err: any): ArchiveFailureReason {
  const msg = String(err?.message || err || "").toLowerCase();
  if (!msg) return "unknown";
  if (/not configured|missing (config|credential|secret)|config missing|unconfigured/.test(msg)) {
    return "config_missing";
  }
  if (err?.name === "AbortError" || /timed? ?out|timeout|aborted/.test(msg)) {
    return "timeout";
  }
  if (/twilio|recording (fetch|download)|media\.twiliocdn|api\.twilio/.test(msg)) {
    return "twilio_fetch_failed";
  }
  if (/object storage|bucket|private_object_dir|storage upload|gcs|sidecar/.test(msg)) {
    return "object_storage_failed";
  }
  if (/transcri|whisper|openai|audio/.test(msg)) {
    return "transcription_failed";
  }
  // Task #4025: in-app client-file sink failures.
  if (/client[- _]?file|folder/.test(msg)) {
    return "client_files_failed";
  }
  if (/econnreset|etimedout|connection terminated|pool|57014|database|db error|relation |column /.test(msg)) {
    return "db_error";
  }
  return "unknown";
}

async function recordFailure(callId: string, err: any, expectedAttempts?: number): Promise<void> {
  const [row] = await db.select().from(twilioCalls).where(eq(twilioCalls.id, callId));
  if (!row) return;
  // Task #1046: archive_attempts is incremented at claim time, so the
  // current row.archiveAttempts already reflects this attempt. Do not
  // bump again here — just decide whether to retry or give up.
  const attempts = row.archiveAttempts || 0;
  const message = String(err?.message || err).slice(0, 500);
  const failureReason = classifyArchiveFailure(err);
  const giveUp = attempts >= MAX_ATTEMPTS;
  // Task #1055: lease-guard the failure write with the captured attempts
  // epoch so a stale, overrun handler doesn't clobber a row that was
  // already reclaimed by a fresh attempt.
  const where = expectedAttempts !== undefined
    ? and(eq(twilioCalls.id, callId), eq(twilioCalls.archiveAttempts, expectedAttempts))!
    : eq(twilioCalls.id, callId);
  const updated = await db.update(twilioCalls)
    .set({
      archiveStatus: giveUp ? "failed" : "queued",
      archiveLastError: message,
      archiveFailureReason: failureReason,
      archiveLockedUntil: null,
      archiveNextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs(attempts)),
      updatedAt: new Date(),
    })
    .where(where)
    .returning({ id: twilioCalls.id });
  if (expectedAttempts !== undefined && updated.length === 0) {
    workerLog({
      worker: "callArchivePipeline",
      event: "job_completion_stale_lease_ignored",
      jobId: callId,
      queueName: CALL_ARCHIVE_QUEUE_NAME,
      attempts: expectedAttempts,
      outcome: "failed",
    });
    return;
  }
  workerLog({
    worker: "callArchivePipeline",
    event: "job_failed",
    jobId: callId,
    queueName: CALL_ARCHIVE_QUEUE_NAME,
    attempts,
    failureReason,
    willRetry: !giveUp,
    error: message,
  });
}

// ---------------------------------------------------------------------------
// Twilio deletion sweep — runs after the 7-day safety window.
// ---------------------------------------------------------------------------
export async function sweepTwilioDeletions(maxBatch = 25): Promise<{ deleted: number; errors: number }> {
  const now = new Date();
  const due = await db.select().from(twilioCalls).where(and(
    eq(twilioCalls.archiveStatus, "done"),
    isNull(twilioCalls.twilioRecordingDeletedAt),
    isNotNull(twilioCalls.recordingSid),
    isNotNull(twilioCalls.twilioDeleteEligibleAt),
    lte(twilioCalls.twilioDeleteEligibleAt, now),
  )).limit(maxBatch);

  let deleted = 0;
  let errors = 0;
  if (due.length === 0) return { deleted, errors };

  const cfg = await getTwilioConfig();
  if (!cfg) {
    console.warn("[CallArchive] Sweep skipped — Twilio not configured");
    return { deleted, errors };
  }
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");

  for (const row of due) {
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Recordings/${row.recordingSid}.json`;
      const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Basic ${auth}` } });
      if (res.ok || res.status === 404) {
        await db.update(twilioCalls)
          .set({ twilioRecordingDeletedAt: new Date(), updatedAt: new Date() })
          .where(eq(twilioCalls.id, row.id));
        deleted++;
        console.log("[CallArchive] Deleted Twilio recording", { callId: row.id, recordingSid: row.recordingSid, status: res.status });
      } else {
        errors++;
        const text = await res.text();
        console.warn("[CallArchive] Twilio recording delete failed", { callId: row.id, status: res.status, body: text.slice(0, 200) });
      }
    } catch (err: any) {
      errors++;
      console.error("[CallArchive] Twilio recording delete error", { callId: row.id, error: err?.message });
    }
  }
  return { deleted, errors };
}

// ---------------------------------------------------------------------------
// Boot: start a single setInterval-driven scheduler. Pattern matches
// SemrushAutoRetry. One poll loop drives the sweeps; staggered tick
// rates keep load predictable.
// ---------------------------------------------------------------------------
let started = false;
export function startCallArchiveScheduler(): void {
  if (started) return;
  started = true;

  const PROCESS_INTERVAL_MS = 30 * 1000;        // pick up new recordings every 30s
  const TWILIO_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // delete-from-Twilio sweep hourly
  console.log("[CallArchive] Scheduler starting (process=30s, twilio-sweep=1h)");

  setInterval(() => {
    void withDbAttribution("worker:call-archive-process", () =>
      processNextBatch().catch((err) => console.error("[CallArchive] processNextBatch error", err?.message)),
    );
  }, PROCESS_INTERVAL_MS).unref();

  setInterval(() => {
    void withDbAttribution("maintenance:call-archive-twilio-sweep", () =>
      sweepTwilioDeletions().catch((err) => console.error("[CallArchive] sweepTwilioDeletions error", err?.message)),
    );
  }, TWILIO_SWEEP_INTERVAL_MS).unref();

}
