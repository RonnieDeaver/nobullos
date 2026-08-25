/* test-registration
{
  "name": "Zoom transcript badge states (Task #3689)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3689: Zoom meeting-modal transcript badge — the three-way available / processing / terminally-unavailable split (plus failed) that replaced the ambiguous hasTranscript-only \"No transcript\" badge, incl. the reason-specific copy listing the exact files Zoom delivered. Pure function, DB-free, network-free, fast; a drift here silently collapses \"still processing\" and \"Zoom will never send one\" back into one badge.",
  "tier": "small"
}
test-registration */
/**
 * Task #3689 — Zoom meeting-modal transcript badge states.
 *
 * The modal badge used to read only rawPayloadJson.hasTranscript, collapsing
 * "still processing" and "Zoom is never going to send one" into one ambiguous
 * "No transcript". getZoomTranscriptBadge (shared/zoomTranscript.ts) is the
 * single source for the transcriptStatus-driven split the client renders:
 *
 *   available   — status 'ready' OR hasTranscript (a late transcript can land
 *                 via the webhook/apply path before the status column catches
 *                 up; presence always wins)
 *   processing  — 'pending'/NULL inside the backfill polling window
 *   unavailable — terminal: window lapsed + live API confirmed no TRANSCRIPT
 *                 file (or the recording is gone from Zoom), with
 *                 reason-specific copy listing the files Zoom DID deliver and
 *                 the "Zoom recording page won't have one either" hint
 *   failed      — pre-existing permanent retrieval failure
 *
 * Pure function; DB-free, network-free.
 */
import assert from "node:assert/strict";
import {
  getZoomTranscriptBadge,
  zoomTranscriptUnavailableReasons,
  ZOOM_TRANSCRIPT_BACKFILL_HOURS,
  ZOOM_TRANSCRIPT_SOURCE_REVAI,
} from "../shared/zoomTranscript";

let passed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  assert.ok(
    cond,
    `${name}${extra !== undefined ? ` (got ${JSON.stringify(extra)})` : ""}`,
  );
  passed++;
}

// ---- 1. available: status 'ready' ----
{
  const b = getZoomTranscriptBadge({ transcriptStatus: "ready", hasTranscript: true });
  check("ready → state available", b.state === "available", b);
  check("ready → label", b.label === "Transcript available", b.label);
  check("ready → no detail", b.detail === null, b.detail);
}

// ---- 2. available: hasTranscript wins over a lagging 'pending' status ----
{
  const b = getZoomTranscriptBadge({ transcriptStatus: "pending", hasTranscript: true });
  check("pending+hasTranscript → available (presence wins)", b.state === "available", b);
}

// ---- 3. available: 'ready' wins even if the payload boolean lagged ----
{
  const b = getZoomTranscriptBadge({ transcriptStatus: "ready", hasTranscript: false });
  check("ready+hasTranscript:false → still available", b.state === "available", b);
}

// ---- 4. processing: 'pending' inside the window ----
{
  const b = getZoomTranscriptBadge({ transcriptStatus: "pending", hasTranscript: false });
  check("pending → state processing", b.state === "processing", b);
  check("pending → label", b.label === "Transcript processing…", b.label);
  check(
    "pending → detail cites the backfill window hours",
    !!b.detail && b.detail.includes(String(ZOOM_TRANSCRIPT_BACKFILL_HOURS)),
    b.detail,
  );
}

// ---- 5. processing: NULL/undefined status (legacy rows) ----
{
  const bNull = getZoomTranscriptBadge({ transcriptStatus: null, hasTranscript: false });
  const bUndef = getZoomTranscriptBadge({ hasTranscript: false });
  check("NULL status → processing", bNull.state === "processing", bNull);
  check("undefined status → processing", bUndef.state === "processing", bUndef);
}

// ---- 6. unavailable: no_transcript_after_window with observed file types ----
{
  const b = getZoomTranscriptBadge({
    transcriptStatus: "unavailable",
    hasTranscript: false,
    unavailableInfo: {
      reason: "no_transcript_after_window",
      fileTypes: ["MP4", "M4A", "TIMELINE"],
      windowHours: ZOOM_TRANSCRIPT_BACKFILL_HOURS,
      at: "2026-08-01T02:00:00.000Z",
    },
  });
  check("unavailable → state unavailable", b.state === "unavailable", b);
  check(
    "unavailable → honest label",
    b.label === "No transcript — Zoom didn't generate one",
    b.label,
  );
  check(
    "unavailable → detail lists the exact files Zoom delivered",
    !!b.detail && b.detail.includes("MP4, M4A, TIMELINE"),
    b.detail,
  );
  check(
    "unavailable → detail hints the Zoom recording page won't have one",
    !!b.detail && b.detail.includes("Zoom recording page won't have one either"),
    b.detail,
  );
}

// ---- 7. unavailable: recording_not_found reason-specific copy ----
{
  const b = getZoomTranscriptBadge({
    transcriptStatus: "unavailable",
    hasTranscript: false,
    unavailableInfo: {
      reason: "recording_not_found",
      windowHours: ZOOM_TRANSCRIPT_BACKFILL_HOURS,
      at: "2026-08-01T02:00:00.000Z",
    },
  });
  check("unavailable/gone → state unavailable", b.state === "unavailable", b);
  check(
    "unavailable/gone → detail says the recording no longer exists",
    !!b.detail && b.detail.includes("no longer exists in Zoom"),
    b.detail,
  );
  check(
    "unavailable/gone → still hints about the Zoom recording page",
    !!b.detail && b.detail.includes("Zoom recording page won't have one either"),
    b.detail,
  );
}

// ---- 8. unavailable with MISSING info (defensive: payload blob lost) ----
{
  const b = getZoomTranscriptBadge({ transcriptStatus: "unavailable", hasTranscript: false });
  check("unavailable w/o info → still unavailable state", b.state === "unavailable", b);
  check(
    "unavailable w/o info → generic no-transcript detail, no 'undefined' text",
    !!b.detail && !b.detail.includes("undefined") && b.detail.includes("Zoom recording page"),
    b.detail,
  );
}

// ---- 9. failed: pre-existing permanent retrieval failure keeps its own copy ----
{
  const b = getZoomTranscriptBadge({ transcriptStatus: "failed", hasTranscript: false });
  check("failed → state failed", b.state === "failed", b);
  check("failed → label", b.label === "No transcript — retrieval failed", b.label);
}

// ---- 10. the four states are visually distinct (no className collisions) ----
{
  const classes = [
    getZoomTranscriptBadge({ transcriptStatus: "ready" }).className,
    getZoomTranscriptBadge({ transcriptStatus: "pending" }).className,
    getZoomTranscriptBadge({ transcriptStatus: "unavailable" }).className,
    getZoomTranscriptBadge({ transcriptStatus: "failed" }).className,
  ];
  check(
    "available/processing/unavailable/failed classNames pairwise distinct",
    new Set(classes).size === 4,
    classes,
  );
}

// ---- 11. reason list lockstep: the server writer uses exactly these four ----
{
  check(
    "zoomTranscriptUnavailableReasons covers exactly the four writer reasons",
    zoomTranscriptUnavailableReasons.length === 4 &&
      zoomTranscriptUnavailableReasons.includes("no_transcript_after_window") &&
      zoomTranscriptUnavailableReasons.includes("recording_not_found") &&
      zoomTranscriptUnavailableReasons.includes("no_audio_file") &&
      zoomTranscriptUnavailableReasons.includes("transcription_failed"),
    zoomTranscriptUnavailableReasons,
  );
}

// ---- 12. Task #3701 — provenance: Rev AI-generated transcript is honest ----
{
  const b = getZoomTranscriptBadge({
    transcriptStatus: "ready",
    hasTranscript: true,
    transcriptSource: ZOOM_TRANSCRIPT_SOURCE_REVAI,
  });
  check("generated → state available", b.state === "available", b);
  check(
    "generated → label says generated, not Zoom-delivered",
    b.label === "Transcript generated from audio",
    b.label,
  );
  check(
    "generated → detail explains audio-recording provenance",
    !!b.detail && b.detail.includes("generated from the audio recording"),
    b.detail,
  );
  check(
    "generated → detail admits Zoom never delivered its own",
    !!b.detail && b.detail.includes("never delivered its own transcript"),
    b.detail,
  );
  // Unknown/other provenance markers must NOT trigger the generated copy.
  const bOther = getZoomTranscriptBadge({
    transcriptStatus: "ready",
    hasTranscript: true,
    transcriptSource: "something_else",
  });
  check(
    "non-revai transcriptSource → plain available label",
    bOther.label === "Transcript available",
    bOther.label,
  );
  const bAbsent = getZoomTranscriptBadge({ transcriptStatus: "ready", hasTranscript: true });
  check(
    "absent transcriptSource → plain available label (Zoom-delivered)",
    bAbsent.label === "Transcript available",
    bAbsent.label,
  );
}

// ---- 13. Task #3701 — unavailable: no_audio_file copy ----
{
  const b = getZoomTranscriptBadge({
    transcriptStatus: "unavailable",
    hasTranscript: false,
    unavailableInfo: {
      reason: "no_audio_file",
      fileTypes: ["MP4", "TIMELINE"],
      windowHours: ZOOM_TRANSCRIPT_BACKFILL_HOURS,
      at: "2026-08-01T02:00:00.000Z",
    },
  });
  check("no_audio_file → state unavailable", b.state === "unavailable", b);
  check(
    "no_audio_file → detail says a transcript can't be generated either",
    !!b.detail && b.detail.includes("without a usable audio file") && b.detail.includes("can't be generated"),
    b.detail,
  );
  check(
    "no_audio_file → detail lists the files Zoom did deliver",
    !!b.detail && b.detail.includes("MP4, TIMELINE"),
    b.detail,
  );
}

// ---- 14. Task #3701 — unavailable: transcription_failed copy ----
{
  const b = getZoomTranscriptBadge({
    transcriptStatus: "unavailable",
    hasTranscript: false,
    unavailableInfo: {
      reason: "transcription_failed",
      fileTypes: ["MP4", "M4A", "TIMELINE"],
      windowHours: ZOOM_TRANSCRIPT_BACKFILL_HOURS,
      at: "2026-08-01T02:00:00.000Z",
      failureDetail: "no speech detected in audio",
    },
  });
  check("transcription_failed → state unavailable", b.state === "unavailable", b);
  check(
    "transcription_failed → label names the failed generation attempt",
    b.label === "No transcript — audio transcription failed",
    b.label,
  );
  check(
    "transcription_failed → detail includes the stored failureDetail",
    !!b.detail && b.detail.includes("no speech detected in audio"),
    b.detail,
  );
  check(
    "transcription_failed → detail promises no silent retries",
    !!b.detail && b.detail.includes("won't retry automatically"),
    b.detail,
  );
  // Without failureDetail the copy still reads cleanly (no "undefined").
  const bNoDetail = getZoomTranscriptBadge({
    transcriptStatus: "unavailable",
    hasTranscript: false,
    unavailableInfo: {
      reason: "transcription_failed",
      windowHours: ZOOM_TRANSCRIPT_BACKFILL_HOURS,
      at: "2026-08-01T02:00:00.000Z",
    },
  });
  check(
    "transcription_failed w/o failureDetail → no 'undefined' in copy",
    !!bNoDetail.detail && !bNoDetail.detail.includes("undefined"),
    bNoDetail.detail,
  );
}

console.log(`\n✅ zoom-transcript-badge-states: all ${passed} assertions passed`);
