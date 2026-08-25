// Task #3689 — single source of truth for the Zoom transcript backfill window
// and the meeting-modal transcript badge, so the server sweep's timing and the
// operator-facing copy can never drift apart.
//
// Zoom behavior this encodes (verified against Zoom's docs + our prod
// source_event_log, Aug 2026):
// - Zoom's audio transcript is a SEPARATE recording file (`file_type:
//   "TRANSCRIPT"`, a VTT) that appears only after Zoom finishes transcript
//   processing — and only when audio transcription is enabled and the audio
//   had usable speech (Zoom KB0064927). Short/no-speech recordings routinely
//   deliver only MP4 (video) + M4A (audio) + TIMELINE (a JSON timeline of
//   meeting events — NOT a transcript) and never produce a TRANSCRIPT file.
// - A 404 with Zoom error code 3301 from the recordings API means the
//   recording was trashed or permanently deleted (Zoom KB0069652); no
//   transcript is ever coming for it.

/**
 * How long after we first see a Zoom recording we keep polling for a late
 * transcript. Past this window the sweep gives the record one final live API
 * check and then parks it in the terminal `unavailable` state.
 */
export const ZOOM_TRANSCRIPT_BACKFILL_HOURS = 72;

export const zoomTranscriptUnavailableReasons = [
  // Recording is final in Zoom but its file set contains no TRANSCRIPT file.
  // Since Task #3701 this is only minted when the Rev AI fallback is
  // kill-switched off (or for pre-#3701 rows) — audio-bearing records now go
  // through generated transcription instead. Rows parked under this reason
  // whose stored fileTypes include M4A remain revivable by the sweep.
  "no_transcript_after_window",
  // Zoom no longer has the recording at all (deleted/trashed/expired → 404/3301).
  "recording_not_found",
  // Task #3701: recording is final with no TRANSCRIPT file AND no audio (M4A)
  // file, so there is nothing to generate a transcript from.
  "no_audio_file",
  // Task #3701: Zoom never generated a transcript and our own speech-to-text
  // generation from the audio recording failed terminally (Rev AI job failed,
  // produced no usable speech, or exhausted its submission attempts).
  "transcription_failed",
] as const;
export type ZoomTranscriptUnavailableReason =
  (typeof zoomTranscriptUnavailableReasons)[number];

/** Stored at rawPayloadJson.zoomTranscriptUnavailable when a record goes terminal. */
export interface ZoomTranscriptUnavailableInfo {
  reason: ZoomTranscriptUnavailableReason;
  /** file_type values Zoom reported in the final check (e.g. ["MP4","M4A","TIMELINE"]). */
  fileTypes?: string[];
  /** Window that had lapsed when we gave up, for audit/copy. */
  windowHours: number;
  /** ISO timestamp of the terminal transition. */
  at: string;
  /**
   * Task #3701: short human-readable failure detail for
   * `transcription_failed` (e.g. Rev AI's failure_detail, "poll_timeout",
   * "submit_attempts_exhausted").
   */
  failureDetail?: string;
}

/**
 * Task #3701 — provenance marker stored at rawPayloadJson.transcriptSource
 * when the transcript was NOT delivered by Zoom but generated from the
 * meeting's audio recording (M4A) via Rev AI speech-to-text. Absent for
 * Zoom-delivered transcripts, so absence means "Zoom delivered it".
 */
export const ZOOM_TRANSCRIPT_SOURCE_REVAI = "revai_audio";

/**
 * Task #3701 — per-record single-flight state machine for the Rev AI
 * transcript generation pipeline, stored at
 * rawPayloadJson.zoomRevAiTranscription. Every transition is a conditional
 * UPDATE so a record can never have two live Rev AI submissions:
 *
 *   (absent) → queued      sweep claimed the record + enqueued the durable job
 *   queued   → submitting  job claimed the submission slot (attempts+1)
 *   submitting → submitted Rev AI job created; revJobId set; polling
 *   submitted → completed  transcript applied (ours, or Zoom's own if it
 *                          appeared late — Zoom's transcript always wins)
 *   any      → failed      terminal, paired with unavailable reason
 *                          `transcription_failed` (or recording_not_found /
 *                          no_audio_file discovered at submit time)
 *
 * Stale in-flight states are reclaimable after a window (crashed worker /
 * dead-lettered poll chain), bounded by the `attempts` cap.
 */
export interface ZoomRevAiTranscriptionMarker {
  state: "queued" | "submitting" | "submitted" | "completed" | "failed";
  /** Total submission attempts consumed (incremented at the submitting claim). */
  attempts: number;
  revJobId?: string | null;
  queuedAt?: string;
  submittingAt?: string;
  submittedAt?: string;
  completedAt?: string;
  failedAt?: string;
  /** e.g. "revai_transcript", "zoom_transcript_won", "attempts_exhausted". */
  outcome?: string;
  lastError?: string;
  /** True when this record was revived from terminal `unavailable` (Task #3701 revival pass). */
  revivedFromUnavailable?: boolean;
}

export type ZoomTranscriptBadgeState =
  | "available"
  | "processing"
  | "unavailable"
  | "failed";

export interface ZoomTranscriptBadge {
  state: ZoomTranscriptBadgeState;
  label: string;
  detail: string | null;
  className: string;
}

/**
 * Three-way (plus pre-existing `failed`) transcript badge for the meeting
 * modal, driven by `transcriptStatus` rather than the bare `hasTranscript`
 * boolean:
 *
 *   available   — transcript is here ('ready', or hasTranscript when a late
 *                 transcript landed before the status column caught up)
 *   processing  — 'pending'/NULL: still inside the backfill polling window
 *   unavailable — terminal: Zoom confirmed it never generated one (with the
 *                 stored reason + the exact files Zoom did deliver)
 *   failed      — permanent retrieval failure (auth/scope/missing metadata)
 */
export function getZoomTranscriptBadge(input: {
  transcriptStatus?: string | null;
  hasTranscript?: boolean | null;
  unavailableInfo?: Partial<ZoomTranscriptUnavailableInfo> | null;
  /**
   * Task #3701: rawPayloadJson.transcriptSource — set to
   * ZOOM_TRANSCRIPT_SOURCE_REVAI when the transcript was generated from the
   * audio recording rather than delivered by Zoom.
   */
  transcriptSource?: string | null;
}): ZoomTranscriptBadge {
  const status = input.transcriptStatus ?? null;

  // A present transcript always wins: the webhook/apply path can deliver a
  // late transcript into contentText/hasTranscript regardless of prior status.
  if (status === "ready" || input.hasTranscript) {
    // Task #3701: be honest about provenance — a generated transcript must
    // not read as if Zoom delivered it.
    if (input.transcriptSource === ZOOM_TRANSCRIPT_SOURCE_REVAI) {
      return {
        state: "available",
        label: "Transcript generated from audio",
        detail:
          "Zoom never delivered its own transcript for this meeting, so this transcript was generated from the audio recording (M4A) with speech-to-text. Wording and speaker labels may be less precise than Zoom's native transcripts.",
        className: "bg-green-50 text-green-600 border-green-200",
      };
    }
    return {
      state: "available",
      label: "Transcript available",
      detail: null,
      className: "bg-green-50 text-green-600 border-green-200",
    };
  }

  if (status === "unavailable") {
    const info = input.unavailableInfo ?? null;
    const fileList =
      info?.fileTypes && info.fileTypes.length > 0
        ? ` Zoom delivered ${info.fileTypes.join(", ")} files only.`
        : "";
    if (info?.reason === "recording_not_found") {
      return {
        state: "unavailable",
        label: "No transcript — Zoom didn't generate one",
        detail:
          "This recording no longer exists in Zoom (deleted or expired), so a transcript is never coming. The Zoom recording page won't have one either.",
        className: "bg-amber-50 text-amber-700 border-amber-200",
      };
    }
    // Task #3701: the recording is final with no transcript AND no audio
    // file, so there is nothing to generate one from either.
    if (info?.reason === "no_audio_file") {
      return {
        state: "unavailable",
        label: "No transcript — Zoom didn't generate one",
        detail: `Zoom finished this recording without a transcript and without a usable audio file, so a transcript can't be generated from it either.${fileList} The Zoom recording page won't have one either.`,
        className: "bg-amber-50 text-amber-700 border-amber-200",
      };
    }
    // Task #3701: our own speech-to-text generation from the audio recording
    // failed terminally.
    if (info?.reason === "transcription_failed") {
      const failureDetail = info?.failureDetail
        ? ` (${info.failureDetail})`
        : "";
      return {
        state: "unavailable",
        label: "No transcript — audio transcription failed",
        detail: `Zoom never generated a transcript, and generating one from the audio recording failed${failureDetail} — usually the audio had no usable speech.${fileList} It won't retry automatically.`,
        className: "bg-amber-50 text-amber-700 border-amber-200",
      };
    }
    return {
      state: "unavailable",
      label: "No transcript — Zoom didn't generate one",
      detail: `Zoom finished this recording without generating a transcript — usually the audio had no usable speech, or transcription failed on Zoom's side.${fileList} The Zoom recording page won't have one either.`,
      className: "bg-amber-50 text-amber-700 border-amber-200",
    };
  }

  if (status === "failed") {
    return {
      state: "failed",
      label: "No transcript — retrieval failed",
      detail:
        "Fetching this transcript from Zoom failed permanently (connection or meeting-metadata problem). It won't retry automatically.",
      className: "bg-red-50 text-red-600 border-red-200",
    };
  }

  // 'pending' / NULL / unknown → the 30-minute backfill sweep is still
  // re-checking this recording against the live Zoom API.
  return {
    state: "processing",
    label: "Transcript processing…",
    detail: `Zoom hasn't delivered a transcript yet. We keep checking for up to ${ZOOM_TRANSCRIPT_BACKFILL_HOURS} hours after the recording lands, then mark it unavailable.`,
    className: "bg-blue-50 text-blue-600 border-blue-200",
  };
}
