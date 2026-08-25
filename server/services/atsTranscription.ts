// Task #3963 (audit B-012) — ATS video-submission transcription via Rev AI,
// completed by CALLBACK instead of an inline poll window.
//
// The pre-#3963 flow submitted a Rev AI job and then inline-polled every 3 s
// for at most 120 s; any job outliving the window was marked
// transcriptionStatus='failed' with no detail — falsely failing valid long
// transcriptions. Now:
//
//   * Submission registers a per-job completion webhook via Rev AI's
//     `notification_config` (see server/routes/revAiWebhook.ts for the
//     receiving route). Only a SHORT optimistic poll remains after submit so
//     quick jobs still complete inline; window expiry leaves the row
//     'processing' — it is never a failure by itself.
//   * `reconcileSubmissionAgainstRevAi()` is the ONE finalization primitive
//     shared by the optimistic poll, the callback route, and the fallback
//     sweeper (server/services/atsTranscriptionSweep.ts). It re-fetches the
//     authoritative job state from Rev AI and applies guarded, idempotent
//     UPDATEs (only rows still 'processing' transition), so duplicate
//     callback deliveries and racing sweeps converge.
//   * Every terminal failure persists a typed machine-readable code
//     (AtsTranscriptionFailureCode) plus safe human-readable detail.
//   * The `ats_revai_transcription` kill switch parks NEW submissions
//     (row stays 'pending', nothing is sent to Rev AI) and idles the
//     sweeper; already-submitted jobs still finalize via the callback.
//
// DB pool note: request-driven entry points (upload fire-and-forget, retry
// endpoints, callback route) run on the api-pool `db` import; the periodic
// sweeper passes its own `workerDb` handle into the shared helpers here, so
// periodic work never rides the api pool.
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";
import { auditedDownload } from "../replit_integrations/object_storage/audit";
import { db } from "../db";
import {
  atsSubmissions,
  type AtsSubmission,
  type AtsTranscriptionFailureCode,
} from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// Task #3701: the raw Rev AI HTTP helpers moved to ./revAiClient so the Zoom
// transcript generation fallback shares one implementation with this flow.
import {
  fetchRevAiTranscriptText,
  getRevAiJobStatus,
  submitRevAiJobFromFile,
  RevAiHttpError,
  type RevAiJobStatusResult,
} from "./revAiClient";
import {
  ensureKillSwitchesLoaded,
  isKillSwitchEnabled,
} from "./killSwitches";
import { getPublicBaseUrl } from "./publicUrl";

const execAsync = promisify(exec);

const objectStorageService = new ObjectStorageService();

/** Both drizzle handles (api `db`, background `workerDb`) satisfy this. */
export type AtsTranscriptionDb = typeof db;

/**
 * Route path the callback route module registers and submissions advertise
 * to Rev AI. The route file (server/routes/revAiWebhook.ts) intentionally
 * repeats the literal so the route-inventory generator can parse it — a
 * route test pins the two in lockstep.
 */
export const REV_AI_CALLBACK_PATH = "/api/webhooks/rev-ai";

/** Short optimistic poll after submit — NOT the arbiter of success. */
export const ATS_REVAI_OPTIMISTIC_POLL_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;

/** Cap persisted human-readable detail (never store unbounded error blobs). */
const MAX_FAILURE_DETAIL_CHARS = 500;

export function getRevAiCallbackSecret(): string | null {
  const s = process.env.REV_AI_CALLBACK_SECRET?.trim();
  return s ? s : null;
}

/** Stage-typed terminal failure carrying the persisted code + detail. */
export class TranscriptionFailure extends Error {
  constructor(
    public readonly code: AtsTranscriptionFailureCode,
    public readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TranscriptionFailure";
  }
}

function errDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the per-job webhook registration, or null when callbacks cannot be
 * used (no shared secret configured, or no public base URL — e.g. a bare
 * local process). Null is NOT an error: the fallback sweeper still
 * reconciles the job; completion is merely slower.
 */
function buildNotificationConfig(): { url: string; authHeaders: Record<string, string> } | null {
  const secret = getRevAiCallbackSecret();
  if (!secret) {
    console.warn(
      "[ATS Transcription] REV_AI_CALLBACK_SECRET is not set — submitting without a completion callback; the fallback sweeper will reconcile this job.",
    );
    return null;
  }
  let base: string;
  try {
    base = getPublicBaseUrl();
  } catch (err) {
    console.warn(
      "[ATS Transcription] No public base URL for the Rev.ai callback — submitting without one; the fallback sweeper will reconcile this job:",
      errDetail(err),
    );
    return null;
  }
  return {
    url: `${base}${REV_AI_CALLBACK_PATH}`,
    // Rev AI replays exactly this header on the callback POST; the route
    // compares it timing-safely against the configured secret.
    authHeaders: { Authorization: `Bearer ${secret}` },
  };
}

/**
 * Guarded terminal-failure write: only a row still 'processing' transitions,
 * so a racing callback/sweep that already finalized wins and this becomes a
 * no-op. Returns whether the write applied.
 */
export async function markTranscriptionTerminalFailure(
  dbh: AtsTranscriptionDb,
  submissionId: string,
  code: AtsTranscriptionFailureCode,
  detail: string,
): Promise<boolean> {
  const truncated =
    detail.length > MAX_FAILURE_DETAIL_CHARS
      ? `${detail.slice(0, MAX_FAILURE_DETAIL_CHARS)}…`
      : detail;
  const updated = await dbh
    .update(atsSubmissions)
    .set({
      transcriptionStatus: "failed",
      transcriptionFailureCode: code,
      transcriptionFailureDetail: truncated,
      transcriptionUpdatedAt: new Date(),
    })
    .where(
      sql`${atsSubmissions.id} = ${submissionId} AND ${atsSubmissions.transcriptionStatus} = 'processing'`,
    )
    .returning({ id: atsSubmissions.id });
  return updated.length > 0;
}

/**
 * Guarded completion write ('processing' → 'completed'/'empty'). Clears any
 * stale failure fields from a prior attempt. Returns the status written, or
 * "not_processing" when another finalizer already won.
 */
export async function finalizeTranscriptionCompletion(
  dbh: AtsTranscriptionDb,
  submissionId: string,
  transcriptText: string,
): Promise<"completed" | "empty" | "not_processing"> {
  const status = transcriptText.length > 0 ? "completed" : "empty";
  const updated = await dbh
    .update(atsSubmissions)
    .set({
      transcriptText: transcriptText || null,
      transcriptionStatus: status,
      transcriptionFailureCode: null,
      transcriptionFailureDetail: null,
      transcriptionUpdatedAt: new Date(),
    })
    .where(
      sql`${atsSubmissions.id} = ${submissionId} AND ${atsSubmissions.transcriptionStatus} = 'processing'`,
    )
    .returning({ id: atsSubmissions.id });
  return updated.length > 0 ? status : "not_processing";
}

export type RevAiReconcileOutcome =
  | "completed"
  | "empty"
  | "failed"
  | "in_progress"
  | "not_processing";

/**
 * THE shared finalization primitive (optimistic poll, callback route, and
 * fallback sweeper all funnel through here). Re-fetches the authoritative
 * job state from Rev AI — callback bodies are treated as correlation-only
 * signals, so a forged/stale body can never write bogus terminal state —
 * then applies the guarded transition:
 *
 *   transcribed → fetch transcript → 'completed' / 'empty'
 *   failed      → typed 'rev_job_failed' with vendor failure + detail
 *   404 job     → typed 'job_not_found'
 *   in_progress → no write (callback/sweeper will try again later)
 *
 * Transient errors (network, Rev AI 5xx) THROW so callers can surface a
 * retryable outcome (the callback route answers 500 → Rev AI redelivers;
 * the sweeper logs and retries next tick).
 */
export async function reconcileSubmissionAgainstRevAi(
  dbh: AtsTranscriptionDb,
  submission: Pick<AtsSubmission, "id" | "revJobId" | "transcriptionStatus">,
): Promise<RevAiReconcileOutcome> {
  if (submission.transcriptionStatus !== "processing" || !submission.revJobId) {
    return "not_processing";
  }
  let job: RevAiJobStatusResult;
  try {
    job = await getRevAiJobStatus(submission.revJobId);
  } catch (err) {
    if (err instanceof RevAiHttpError && err.status === 404) {
      await markTranscriptionTerminalFailure(
        dbh,
        submission.id,
        "job_not_found",
        `Rev.ai job ${submission.revJobId} no longer exists (404) — it may have been deleted or belong to another environment; retry via the ATS retry endpoint`,
      );
      return "failed";
    }
    throw err;
  }

  if (job.status === "transcribed") {
    let text: string;
    try {
      text = await fetchRevAiTranscriptText(submission.revJobId);
    } catch (err) {
      if (err instanceof RevAiHttpError && err.status === 404) {
        await markTranscriptionTerminalFailure(
          dbh,
          submission.id,
          "transcript_fetch_failed",
          `Rev.ai reports job ${submission.revJobId} transcribed but the transcript is gone (404)`,
        );
        return "failed";
      }
      throw err; // transient — caller retries later
    }
    const fin = await finalizeTranscriptionCompletion(dbh, submission.id, text);
    if (fin === "not_processing") return "not_processing";
    console.log(
      `[ATS Transcription] Submission ${submission.id} finalized '${fin}' from Rev.ai job ${submission.revJobId}`,
    );
    return fin;
  }

  if (job.status === "failed") {
    const detail =
      [job.failure, job.failure_detail].filter(Boolean).join(": ") ||
      "Rev.ai reported failure without detail";
    await markTranscriptionTerminalFailure(
      dbh,
      submission.id,
      "rev_job_failed",
      detail,
    );
    return "failed";
  }

  return "in_progress";
}

export type RevAiCallbackResult =
  | { outcome: "bad_payload" }
  | { outcome: "unknown_job" }
  | { outcome: "already_terminal"; submissionId: string }
  | { outcome: RevAiReconcileOutcome; submissionId: string };

/**
 * Callback-route entry point: correlate `body.job.id` to a submission via
 * the persisted rev_job_id mapping, then reconcile against Rev AI.
 * Idempotent on redelivery — an already-finalized row answers
 * "already_terminal" without touching Rev AI again.
 */
export async function processRevAiCallback(
  body: unknown,
): Promise<RevAiCallbackResult> {
  const rawId = (body as { job?: { id?: unknown } } | null | undefined)?.job?.id;
  const jobId = typeof rawId === "string" ? rawId.trim() : "";
  if (!jobId) return { outcome: "bad_payload" };

  const [submission] = await db
    .select()
    .from(atsSubmissions)
    .where(eq(atsSubmissions.revJobId, jobId))
    .limit(1);
  if (!submission) return { outcome: "unknown_job" };
  if (submission.transcriptionStatus !== "processing") {
    return { outcome: "already_terminal", submissionId: submission.id };
  }
  const outcome = await reconcileSubmissionAgainstRevAi(db, submission);
  return { outcome, submissionId: submission.id };
}

// ── Audio preparation (test seam) ────────────────────────────────────────

type AudioPreparer = (
  submission: AtsSubmission,
  videoPath: string,
  audioPath: string,
) => Promise<string>;

let audioPreparerOverride: AudioPreparer | null = null;

/**
 * Test seam: replaces the object-storage download + ffmpeg extraction step
 * (the only part of the flow that needs real media). Pass null to restore.
 */
export function __setAtsAudioPreparerForTest(fn: AudioPreparer | null): void {
  audioPreparerOverride = fn;
}

async function prepareAudio(
  submission: AtsSubmission,
  videoPath: string,
  audioPath: string,
): Promise<string> {
  if (audioPreparerOverride) {
    return audioPreparerOverride(submission, videoPath, audioPath);
  }
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(
      submission.videoObjectKey!,
    );
    const [buffer] = await auditedDownload(objectFile);
    await fs.promises.writeFile(videoPath, buffer);
  } catch (err) {
    throw new TranscriptionFailure("download_failed", errDetail(err));
  }
  try {
    await execAsync(
      `ffmpeg -y -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" 2>/dev/null`,
    );
  } catch (err) {
    throw new TranscriptionFailure("audio_extract_failed", errDetail(err));
  }
  return audioPath;
}

// ── Optimistic poll ──────────────────────────────────────────────────────

/**
 * Short post-submit poll so quick jobs complete inline. Window expiry is
 * NOT a failure (audit B-012): the row stays 'processing' and the callback
 * or the fallback sweeper finalizes it. Always performs at least one check.
 */
async function optimisticPoll(
  submissionId: string,
  maxWaitMs: number,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const [row] = await db
      .select()
      .from(atsSubmissions)
      .where(eq(atsSubmissions.id, submissionId));
    if (!row || row.transcriptionStatus !== "processing" || !row.revJobId) {
      return; // finalized elsewhere (callback won) or row gone
    }
    try {
      const outcome = await reconcileSubmissionAgainstRevAi(db, row);
      if (outcome !== "in_progress") return;
    } catch (err) {
      // Transient poll error never fails the row — callback/sweeper covers it.
      console.warn(
        `[ATS Transcription] Optimistic poll check failed for ${submissionId} (callback/sweeper will finalize):`,
        errDetail(err),
      );
    }
    if (Date.now() - start >= maxWaitMs) {
      console.log(
        `[ATS Transcription] Rev.ai job for submission ${submissionId} still in progress after the ${Math.round(maxWaitMs / 1000)}s optimistic poll window — leaving transcriptionStatus='processing'; the callback or fallback sweeper will finalize it.`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// ── Main entry point ─────────────────────────────────────────────────────

export async function transcribeVideoSubmission(
  submissionId: string,
  opts: { optimisticPollMs?: number } = {},
): Promise<void> {
  const [submission] = await db
    .select()
    .from(atsSubmissions)
    .where(eq(atsSubmissions.id, submissionId));

  if (!submission || submission.questionType !== "video" || !submission.videoObjectKey) {
    return;
  }

  if (submission.transcriptionStatus === "completed" && submission.transcriptText) {
    return;
  }

  if (submission.transcriptionStatus === "processing") {
    // Another worker owns it (or it awaits callback). If a job id exists,
    // opportunistically reconcile — this also recovers pre-#3963 rows.
    if (submission.revJobId) {
      try {
        await reconcileSubmissionAgainstRevAi(db, submission);
      } catch (err) {
        console.warn(
          `[ATS Transcription] Reconcile of in-flight submission ${submissionId} failed (sweeper will retry):`,
          errDetail(err),
        );
      }
    }
    return;
  }

  // Kill switch parks the row BEFORE the claim: status stays 'pending' (or
  // failed/empty), nothing is sent to Rev AI, and the existing ATS retry
  // endpoints re-drive it once the switch is released.
  await ensureKillSwitchesLoaded();
  if (isKillSwitchEnabled("ats_revai_transcription")) {
    console.log(
      `[ATS Transcription] ats_revai_transcription kill switch engaged — leaving submission ${submissionId} un-submitted (status unchanged).`,
    );
    return;
  }

  const claimed = await db
    .update(atsSubmissions)
    .set({
      transcriptionStatus: "processing",
      transcriptionFailureCode: null,
      transcriptionFailureDetail: null,
      transcriptionUpdatedAt: new Date(),
    })
    .where(
      sql`${atsSubmissions.id} = ${submissionId} AND (${atsSubmissions.transcriptionStatus} IS NULL OR ${atsSubmissions.transcriptionStatus} IN ('pending', 'failed', 'empty'))`,
    )
    .returning();

  if (claimed.length === 0) {
    return;
  }

  const tmpDir = os.tmpdir();
  const videoPath = path.join(tmpDir, `ats-video-${submissionId}.webm`);
  const audioPath = path.join(tmpDir, `ats-audio-${submissionId}.wav`);

  try {
    const preparedAudioPath = await prepareAudio(submission, videoPath, audioPath);

    const notificationConfig = buildNotificationConfig();
    let revJobId: string;
    try {
      revJobId = await submitRevAiJobFromFile(preparedAudioPath, {
        filename: "audio.wav",
        contentType: "audio/wav",
        metadata: "ATS video submission transcription",
        notificationConfig: notificationConfig ?? undefined,
      });
    } catch (err) {
      throw new TranscriptionFailure("submit_failed", errDetail(err));
    }
    console.log(
      `[ATS Transcription] Rev.ai job submitted: ${revJobId}${notificationConfig ? " (completion callback registered)" : " (no callback — sweeper fallback only)"}`,
    );

    // Persist the mapping immediately — a submitted job whose id is lost
    // cannot be correlated by the callback or recovered by the sweeper.
    await db
      .update(atsSubmissions)
      .set({ revJobId, transcriptionUpdatedAt: new Date() })
      .where(eq(atsSubmissions.id, submissionId));

    await optimisticPoll(
      submissionId,
      opts.optimisticPollMs ?? ATS_REVAI_OPTIMISTIC_POLL_MS,
    );
  } catch (error: unknown) {
    const code: AtsTranscriptionFailureCode =
      error instanceof TranscriptionFailure ? error.code : "unknown";
    const detail =
      error instanceof TranscriptionFailure ? error.detail : errDetail(error);
    console.error(
      `[ATS Transcription] Terminal failure for ${submissionId} [${code}]: ${detail}`,
    );
    await markTranscriptionTerminalFailure(db, submissionId, code, detail).catch(
      (err) =>
        console.error(
          `[ATS Transcription] Failed to persist terminal failure for ${submissionId}:`,
          errDetail(err),
        ),
    );
  } finally {
    try { await fs.promises.unlink(videoPath); } catch {}
    try { await fs.promises.unlink(audioPath); } catch {}
  }
}
