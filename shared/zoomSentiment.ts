// Task #3702 — single source of truth for the Zoom client face-sentiment
// result stored at `rawPayloadJson.zoomFaceSentiment` on a Zoom
// raw_communication_records row, plus the meeting-modal presentation helper,
// so the background analyzer's stored shape and the operator-facing copy can
// never drift apart.
//
// How the client's face is identified vs. team members (documented decision):
// - Zoom cloud MP4s are a flat composite (speaker view, gallery view, or
//   shared-screen-with-speaker) — Zoom does not expose per-participant video
//   streams, so identification is best-effort from the visible frame.
// - The analyzer gives the vision model the meeting's participant list split
//   into team-side (participants ingested with a resolvable user email /
//   host role) and likely client-side (role "external") names, and instructs
//   it to use visible Zoom name labels on tiles to locate the client.
// - CONSERVATIVE FALLBACK: when the model cannot confidently identify a
//   client face (camera off, screen-share-only frames, no name labels, or
//   ambiguous faces), it must report client_visible=false and the record is
//   stored as `no_video` / `client_not_visible` — an explicit "no video to
//   analyze" outcome, never a guessed reading of the wrong person.

/** Bump when the stored result shape or analysis semantics change. */
export const ZOOM_FACE_SENTIMENT_VERSION = 1;

/**
 * Sweep-driven retry budget for `failed` results. A failed record is retried
 * by the background sweep until it has consumed this many attempts, then it
 * parks as reviewable-failed (visible in the meeting modal) instead of
 * retrying forever.
 */
export const ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS = 3;

export const zoomFaceSentimentStatuses = [
  // A client face was confidently identified and read across sampled frames.
  "analyzed",
  // Explicit "no video to analyze" — see reasons below. Terminal.
  "no_video",
  // The pipeline errored (download/frame/vision/etc.). Retried by the sweep
  // up to ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS, then parked.
  "failed",
] as const;
export type ZoomFaceSentimentStatus = (typeof zoomFaceSentimentStatuses)[number];

export const zoomFaceSentimentNoVideoReasons = [
  // The meeting's final recording set has no MP4 video file (e.g. audio-only
  // M4A + TIMELINE), or Zoom reported zero recording files at ingest.
  "no_video_file",
  // Zoom no longer has the recording at all (deleted/trashed/expired → 404/3301).
  "recording_unavailable",
  // Video exists but no client face could be confidently identified —
  // camera off, screen-share-only content, or unidentifiable participants.
  "client_not_visible",
] as const;
export type ZoomFaceSentimentNoVideoReason =
  (typeof zoomFaceSentimentNoVideoReasons)[number];

export const zoomClientOverallSentiments = [
  "positive",
  "neutral",
  "mixed",
  "negative",
] as const;
export type ZoomClientOverallSentiment =
  (typeof zoomClientOverallSentiments)[number];

export const zoomTimelineSentiments = [
  "positive",
  "neutral",
  "negative",
  "unclear",
] as const;
export type ZoomTimelineSentiment = (typeof zoomTimelineSentiments)[number];

export interface ZoomSentimentTimelinePoint {
  /** Seconds into the meeting the sampled frame was taken. */
  atSec: number;
  sentiment: ZoomTimelineSentiment;
  /** Short observation for this sample, when the model offered one. */
  note?: string;
}

export interface ZoomSentimentNotableMoment {
  atSec: number;
  /** e.g. "visible frustration while discussing billing". */
  note: string;
}

export interface ZoomFaceSentimentClientIdentification {
  /** How the client was located in-frame (name label, elimination, …). */
  description: string;
  confidence: "high" | "medium" | "low";
}

/** Stored at rawPayloadJson.zoomFaceSentiment. */
export interface ZoomFaceSentimentResult {
  status: ZoomFaceSentimentStatus;
  version: number;
  /** ISO timestamp of the last transition (analysis, no-video stamp, or failure). */
  at: string;

  // ── analyzed ────────────────────────────────────────────────────────────
  overall?: ZoomClientOverallSentiment;
  summary?: string;
  timeline?: ZoomSentimentTimelinePoint[];
  notableMoments?: ZoomSentimentNotableMoment[];
  clientIdentification?: ZoomFaceSentimentClientIdentification;
  framesSampled?: number;
  framesWithClientVisible?: number;
  /** Provenance: vision model that produced the read. */
  model?: string;

  // ── no_video ────────────────────────────────────────────────────────────
  reason?: ZoomFaceSentimentNoVideoReason;
  /** Human context for the no_video reason (e.g. what the frames showed). */
  detail?: string;
  /** file_type values Zoom reported when the set had no MP4. */
  fileTypes?: string[];

  // ── failed ──────────────────────────────────────────────────────────────
  error?: string;
  /** Failure attempts consumed so far (sweep retries while < max). */
  attempts?: number;
}

export function formatSentimentTimestamp(atSec: number): string {
  const total = Math.max(0, Math.round(atSec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Tailwind classes for the overall-sentiment badge in the meeting modal. */
export function getOverallSentimentClassName(
  overall: ZoomClientOverallSentiment | undefined,
): string {
  switch (overall) {
    case "positive":
      return "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/25 dark:text-green-300 dark:border-green-800";
    case "negative":
      return "bg-red-50 text-red-600 border-red-200 dark:bg-red-950/25 dark:text-red-400 dark:border-red-800";
    case "mixed":
      return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/25 dark:text-amber-300 dark:border-amber-800";
    case "neutral":
    default:
      return "bg-gray-50 text-gray-600 border-gray-200";
  }
}

export function getTimelineSentimentClassName(
  sentiment: ZoomTimelineSentiment,
): string {
  switch (sentiment) {
    case "positive":
      return "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/25 dark:text-green-300 dark:border-green-800";
    case "negative":
      return "bg-red-50 text-red-600 border-red-200 dark:bg-red-950/25 dark:text-red-400 dark:border-red-800";
    case "unclear":
      return "bg-gray-50 text-gray-400 border-gray-200";
    case "neutral":
    default:
      return "bg-gray-50 text-gray-600 border-gray-200";
  }
}

export type ZoomFaceSentimentBadgeState =
  | "analyzed"
  | "no_video"
  | "failed"
  | "none";

export interface ZoomFaceSentimentBadge {
  state: ZoomFaceSentimentBadgeState;
  label: string;
  detail: string | null;
  className: string;
}

/**
 * Meeting-modal badge for the face-sentiment block. `none` (absent result)
 * means the analyzer hasn't produced a result for this meeting — the modal
 * renders nothing in that case (the feature is opt-in and backfills on a
 * sweep cadence, so absence is expected, not an error).
 */
export function getZoomFaceSentimentBadge(
  result: Partial<ZoomFaceSentimentResult> | null | undefined,
): ZoomFaceSentimentBadge {
  if (!result || !result.status) {
    return { state: "none", label: "", detail: null, className: "" };
  }

  if (result.status === "analyzed") {
    return {
      state: "analyzed",
      label: "Client sentiment analyzed",
      detail: null,
      className: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/25 dark:text-violet-300 dark:border-violet-800",
    };
  }

  if (result.status === "no_video") {
    const detail =
      result.reason === "recording_unavailable"
        ? "This recording no longer exists in Zoom (deleted or expired), so there is no video to analyze."
        : result.reason === "client_not_visible"
          ? `The recording was checked, but no client face could be confidently identified — usually the client's camera was off or the recording only shows a shared screen.${result.detail ? ` ${result.detail}` : ""}`
          : `This meeting has no video file to analyze.${
              result.fileTypes && result.fileTypes.length > 0
                ? ` Zoom delivered ${result.fileTypes.join(", ")} files only.`
                : ""
            }`;
    return {
      state: "no_video",
      label: "No video to analyze",
      detail,
      className: "bg-gray-50 text-gray-600 border-gray-200",
    };
  }

  const attempts = result.attempts ?? 0;
  const exhausted = attempts >= ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS;
  return {
    state: "failed",
    label: "Sentiment analysis failed",
    detail: exhausted
      ? `Analysis failed ${attempts} times and won't retry automatically.${result.error ? ` Last error: ${result.error}` : ""}`
      : `Analysis failed (attempt ${attempts} of ${ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS}); the background sweep will retry.${result.error ? ` Last error: ${result.error}` : ""}`,
    className: "bg-red-50 text-red-600 border-red-200 dark:bg-red-950/25 dark:text-red-400 dark:border-red-800",
  };
}
