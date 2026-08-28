/* test-registration
{
  "name": "Zoom Rev AI transcript fallback (Task #3701)",
  "regression": true,
  "sweepOnlyReason": "Task #3701 — Rev AI generation fallback: seeds raw_communication_records + work_queue rows in the hermetic per-run DB, snapshots/restores zoom token settings AND the kill-switch override row; DB-heavy like the #3689 sweep suite, not a smoke-gate candidate (badge lockstep is gated via zoom-transcript-badge-states).",
  "tier": "medium",
  "tierReason": "Seeds and processes durable Zoom/Rev AI fallback work through the hermetic database."
}
test-registration */
/**
 * Task #3701 — Zoom recordings with audio but no Zoom transcript get a
 * Rev AI-generated transcript instead of parking terminally.
 *
 * Drives the REAL sweep processor + Rev AI pipeline processor against the
 * hermetic per-run test DB with stubbed Zoom + Rev AI HTTP, asserting:
 *
 *   1. Sweep fallback trigger: past-window + final recording set with M4A
 *      but no TRANSCRIPT → durable work_queue job enqueued (marker 'queued',
 *      record stays 'pending'), and the next sweep early-skips WITHOUT a
 *      live Zoom API call.
 *   2. Pipeline success: M4A downloaded, Rev AI submitted, quick-poll
 *      completion → contentText populated, transcriptStatus 'ready',
 *      provenance transcriptSource='revai_audio', marker 'completed', and
 *      the analyze_communication handoff enqueued. Idempotent re-run.
 *   3. No audio at all → terminal 'unavailable' reason `no_audio_file`
 *      (fileTypes stored, no marker, no submission).
 *   4. Rev AI job fails → terminal reason `transcription_failed` with
 *      failureDetail; excluded from re-enumeration AND revival (no bounce).
 *   5. Zoom-delivered transcript short-circuits: at sweep time (backfilled,
 *      zero Rev AI involvement) and inside the pipeline job (Zoom transcript
 *      wins, zero Rev AI submissions, no generated provenance).
 *   6. Revival exactly-once: #3689-parked rows (reason
 *      no_transcript_after_window + M4A in stored fileTypes) are re-queued
 *      once — a fresh claim blocks the next pass, success → ready+provenance,
 *      failure → terminal transcription_failed and never selected again.
 *      Non-M4A and recording_not_found rows are never candidates. Revived
 *      rows stay 'unavailable' while in flight (no terminal↔pending bounce).
 *   7. Kill switch: sweep parks records exactly like #3689 (revivable),
 *      revival returns zeros, the job processor refuses to run — and after
 *      release the revival pass picks the parked row up.
 *   8. Submission cap: when the rolling-window submission count saturates,
 *      the sweep defers (no marker) and revival reports capped.
 *   9. Durable polling: quick-poll exhaustion → 'submitted' marker + delayed
 *      poll job; a later poll run completes with exactly ONE submission.
 *  10. Empty Rev AI transcript (no usable speech) → terminal
 *      `transcription_failed` / empty_transcript.
 *
 * Seeds tagged rows (workerDb bypasses the tx sandbox) and deletes them +
 * all tagged work_queue rows in `finally`. Zoom token settings and the
 * kill-switch override row are snapshotted and restored. No dev-server
 * coordination is needed: the suite runs against the hermetic per-run DB
 * (Task #3797), which the dev server's dispatch loops never touch.
 */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";

process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "task3701_client_id";
process.env.ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || "task3701_client_secret";
process.env.ZOOM_REDIRECT_URI = process.env.ZOOM_REDIRECT_URI || "https://example.com/api/zoom/callback";
// Stubbed fetch means no real Rev AI traffic; a fake token guarantees any
// stub gap would 401 against the real API instead of spending money.
process.env.REV_AI_API_TOKEN = "task3701_fake_revai_token";
// Keep the in-job quick poll fast and the submission budget roomy.
process.env.ZOOM_REVAI_QUICK_POLL_ATTEMPTS = "2";
process.env.ZOOM_REVAI_QUICK_POLL_INTERVAL_MS = "10";
process.env.ZOOM_REVAI_MAX_SUBMISSIONS_PER_SWEEP = "50";

const TAG = `t3701_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const ZOOM_API_BASE = "https://api.zoom.us/v2";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const REVAI_BASE = "https://api.rev.ai/speechtotext/v1";

const originalFetch: typeof fetch = global.fetch;
const {
  isUpstashRedisUrl,
  makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---- Zoom stub state ----
type RecordingShape = { files: any[] } | { gone: true };
const recordingShapes = new Map<string, RecordingShape>();
/** Zoom recordings-API calls per meeting uuid — proves skip paths never re-fetch. */
const apiCalls = new Map<string, number>();

const VTT = [
  "WEBVTT",
  "",
  "00:00:01.000 --> 00:00:03.000",
  "Alice: Hello from the Zoom transcript.",
  "",
].join("\n");

function threeFileSet(uuid: string): any[] {
  return [
    { file_type: "MP4", download_url: `https://api.zoom.us/rec/${uuid}/mp4` },
    { file_type: "M4A", download_url: `https://api.zoom.us/rec/${uuid}/audio.m4a` },
    { file_type: "TIMELINE", download_url: `https://api.zoom.us/rec/${uuid}/timeline` },
  ];
}
function withZoomTranscript(uuid: string): any[] {
  return [...threeFileSet(uuid), { file_type: "TRANSCRIPT", download_url: `https://api.zoom.us/rec/${uuid}/vtt` }];
}

// ---- Rev AI stub state ----
interface RevAiJobScript {
  statuses: string[]; // shifted per status GET; last value repeats
  transcript?: string;
  failure_detail?: string;
}
/** Script attached to the NEXT submission for a given recordId (metadata rides in the `options` JSON multipart part since Task #3963 / audit B-012). */
const revAiScriptByRecord = new Map<string, RevAiJobScript>();
const revAiJobs = new Map<string, RevAiJobScript>();
const revAiJobByRecord = new Map<string, string>();
const revAiSubmissionsByRecord = new Map<string, number>();
let revAiJobCounter = 0;

global.fetch = (async (input: any, init?: any) => {
  if (isUpstashRedisUrl(input)) return makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);

  if (url === ZOOM_TOKEN_URL || url.includes("zoom.us/oauth/token")) {
    throw new Error(`Unexpected token refresh during test: ${url}`);
  }

  // Rev AI endpoints.
  if (url.startsWith(REVAI_BASE)) {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url === `${REVAI_BASE}/jobs`) {
      // Task #3963 (audit B-012): job options — including our correlation
      // metadata — travel inside the single documented `options` JSON part
      // (the old loose top-level `metadata` part is gone).
      const optionsRaw = String((init?.body as FormData)?.get?.("options") ?? "");
      let metadata = "";
      try {
        metadata = String(JSON.parse(optionsRaw)?.metadata ?? "");
      } catch {
        // leave metadata empty — the throw below names the bad submission
      }
      const recordId = metadata.startsWith("zoom_transcript:")
        ? metadata.slice("zoom_transcript:".length)
        : "";
      const script = revAiScriptByRecord.get(recordId);
      if (!script) {
        throw new Error(`Unexpected Rev AI submission for record "${recordId}" (no script)`);
      }
      const jobId = `revjob_${TAG}_${++revAiJobCounter}`;
      revAiJobs.set(jobId, { ...script, statuses: [...script.statuses] });
      revAiJobByRecord.set(recordId, jobId);
      revAiSubmissionsByRecord.set(recordId, (revAiSubmissionsByRecord.get(recordId) ?? 0) + 1);
      return jsonResponse({ id: jobId, status: "in_progress" });
    }
    const transcriptMatch = url.match(/\/jobs\/([^/]+)\/transcript$/);
    if (transcriptMatch) {
      const job = revAiJobs.get(transcriptMatch[1]);
      if (!job) return new Response("not found", { status: 404 });
      return new Response(job.transcript ?? "", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    const statusMatch = url.match(/\/jobs\/([^/]+)$/);
    if (statusMatch) {
      const job = revAiJobs.get(statusMatch[1]);
      if (!job) return jsonResponse({ error: "not found" }, 404);
      const status = job.statuses.length > 1 ? job.statuses.shift()! : job.statuses[0];
      return jsonResponse({
        id: statusMatch[1],
        status,
        ...(status === "failed"
          ? { failure: "transcription", failure_detail: job.failure_detail ?? "unknown" }
          : {}),
      });
    }
    throw new Error(`Unexpected Rev AI URL in test: ${url}`);
  }

  // Zoom recording-file downloads (VTT + M4A).
  const recMatch = url.match(/api\.zoom\.us\/rec\/([^/]+)\/([^/?]+)/);
  if (recMatch) {
    const kind = recMatch[2];
    if (kind === "vtt") {
      return new Response(VTT, { status: 200, headers: { "content-type": "text/vtt" } });
    }
    // 1 KiB of fake M4A bytes.
    return new Response(Buffer.alloc(1024, 7), {
      status: 200,
      headers: { "content-type": "audio/mp4" },
    });
  }

  // Zoom REST API.
  if (url.startsWith(ZOOM_API_BASE) || url.includes("api.zoom.us/")) {
    const m = url.match(/\/meetings\/([^/]+)\/recordings/);
    const uuid = m ? decodeURIComponent(m[1]) : "";
    apiCalls.set(uuid, (apiCalls.get(uuid) ?? 0) + 1);
    const shape = recordingShapes.get(uuid);
    if (!shape) throw new Error(`Unexpected Zoom recordings call for uuid "${uuid}"`);
    if ("gone" in shape) {
      return jsonResponse({ code: 3301, message: "This recording does not exist." }, 404);
    }
    return jsonResponse({ uuid, recording_files: shape.files });
  }

  return originalFetch(input as any, init);
}) as any;

const { workerDb } = await import("../server/db");
const { rawCommunicationRecords } = await import("../shared/models/communications");
const { workQueue } = await import("../shared/models/workQueue");
const { storage } = await import("../server/storage");
const { eq, inArray, like } = await import("drizzle-orm");
const {
  enqueueTranscriptBackfillBatch,
  processTranscriptBackfillRecord,
  processZoomRevAiTranscriptionJob,
  reviveUnavailableRecordsForRevAi,
  clearZoomPermanentFailure,
  clearZoomValidationBreaker,
  __clearPersistedZoomAuthGateForTest,
  __disableZoomAuthSelfHealForTest,
} = await import("../server/services/zoomIntegration");
const { __resetIntegrationStatusCacheForTest } = await import(
  "../server/services/integrationStatusCache"
);
const { setKillSwitch } = await import("../server/services/killSwitches");
const { ZOOM_TRANSCRIPT_SOURCE_REVAI } = await import("../shared/zoomTranscript");

const SETTINGS = {
  ACCESS: "zoom_access_token",
  REFRESH: "zoom_refresh_token",
  EXPIRES: "zoom_token_expires_at",
} as const;
const REVAI_KILL_SWITCH_KEY = "kill_switch_zoom_revai_transcription";

async function snapshotZoomSettings() {
  return {
    access: (await storage.getSystemSetting(SETTINGS.ACCESS))?.value ?? null,
    refresh: (await storage.getSystemSetting(SETTINGS.REFRESH))?.value ?? null,
    expires: (await storage.getSystemSetting(SETTINGS.EXPIRES))?.value ?? null,
  };
}
async function restoreZoomSettings(
  snap: Awaited<ReturnType<typeof snapshotZoomSettings>>,
) {
  await storage.setSystemSetting(SETTINGS.ACCESS, snap.access ?? "", "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, snap.refresh ?? "", "test");
  await storage.setSystemSetting(SETTINGS.EXPIRES, snap.expires ?? "", "test");
}

let passed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  assert.ok(
    cond,
    `${name}${extra !== undefined ? ` (got ${JSON.stringify(extra)})` : ""}`,
  );
  passed++;
  console.log(`  ✓ ${name}`);
}

async function getRow(id: string) {
  const [row] = await workerDb
    .select()
    .from(rawCommunicationRecords)
    .where(eq(rawCommunicationRecords.id, id))
    .limit(1);
  return row;
}
function marker(row: any) {
  return (row?.rawPayloadJson as any)?.zoomRevAiTranscription ?? null;
}
function unavailableInfo(row: any) {
  return (row?.rawPayloadJson as any)?.zoomTranscriptUnavailable ?? null;
}
async function queueRowsByDedupe(pattern: string) {
  return workerDb.select().from(workQueue).where(like(workQueue.dedupeKey, pattern));
}
/** Polls for a fire-and-forget enqueue (analysis handoff races the assert). */
async function waitForQueueRow(pattern: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await queueRowsByDedupe(pattern)).length > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const HOURS = 60 * 60 * 1000;
const aged = new Date(Date.now() - 80 * HOURS); // well past the 72h window

// Record ids double as work_queue dedupe-key fragments, so everything this
// test enqueues is TAG-scoped and cleanable.
const R_QUICK = `${TAG}_quick`;
const R_NOAUDIO = `${TAG}_noaudio`;
const R_FAIL = `${TAG}_fail`;
const R_ZWS = `${TAG}_zoomwin_sweep`;
const R_ZWJ = `${TAG}_zoomwin_job`;
const R_REVIVE_OK = `${TAG}_revive_ok`;
const R_REVIVE_FAIL = `${TAG}_revive_fail`;
const R_REVIVE_NOM4A = `${TAG}_revive_nom4a`;
const R_REVIVE_GONE = `${TAG}_revive_gone`;
const R_KILL = `${TAG}_kill`;
const R_CAP = `${TAG}_cap`;
const R_POLL = `${TAG}_poll`;
const R_EMPTY = `${TAG}_empty`;
const ALL_IDS = [
  R_QUICK, R_NOAUDIO, R_FAIL, R_ZWS, R_ZWJ,
  R_REVIVE_OK, R_REVIVE_FAIL, R_REVIVE_NOM4A, R_REVIVE_GONE,
  R_KILL, R_CAP, R_POLL, R_EMPTY,
];
const uuidOf = (id: string) => `${id}_uuid`;

const settingsSnap = await snapshotZoomSettings();
const revAiKillSwitchSnap =
  (await storage.getSystemSetting(REVAI_KILL_SWITCH_KEY))?.value ?? null;

try {
  await storage.setSystemSetting(SETTINGS.ACCESS, `${TAG}_access`, "test");
  await storage.setSystemSetting(SETTINGS.REFRESH, `${TAG}_refresh`, "test");
  await storage.setSystemSetting(
    SETTINGS.EXPIRES,
    String(Math.floor(Date.now() / 1000) + 3600),
    "test",
  );
  clearZoomPermanentFailure("test_reset");
  clearZoomValidationBreaker();
  await __clearPersistedZoomAuthGateForTest();
  __disableZoomAuthSelfHealForTest();
  __resetIntegrationStatusCacheForTest();
  await setKillSwitch("zoom_revai_transcription", false, "test");

  // Purge stale capfill rows from a previous crashed run.
  await workerDb.delete(workQueue).where(like(workQueue.dedupeKey, "zoom_revai:submit:capfill_%"));

  // ---- Seed ----
  async function seedPending(id: string) {
    await workerDb.insert(rawCommunicationRecords).values({
      id,
      sourceType: "zoom",
      title: `Task3701 seed ${id}`,
      timestamp: aged,
      transcriptStatus: "pending",
      contentText: null,
      createdAt: aged,
      rawPayloadJson: { meetingUuid: uuidOf(id), hasTranscript: false, recordingCount: 3 },
    });
  }
  async function seedUnavailable(
    id: string,
    reason: string,
    fileTypes?: string[],
  ) {
    await workerDb.insert(rawCommunicationRecords).values({
      id,
      sourceType: "zoom",
      title: `Task3701 seed ${id}`,
      timestamp: aged,
      transcriptStatus: "unavailable",
      contentText: null,
      createdAt: aged,
      rawPayloadJson: {
        meetingUuid: uuidOf(id),
        hasTranscript: false,
        recordingCount: 3,
        zoomTranscriptUnavailable: {
          reason,
          windowHours: 72,
          at: new Date(Date.now() - 5 * 24 * HOURS).toISOString(),
          ...(fileTypes ? { fileTypes } : {}),
        },
      },
    });
  }

  for (const id of [R_QUICK, R_NOAUDIO, R_FAIL, R_ZWS, R_ZWJ, R_KILL, R_CAP, R_POLL, R_EMPTY]) {
    await seedPending(id);
  }
  // #3689-shape terminal rows for the revival scenarios.
  await seedUnavailable(R_REVIVE_OK, "no_transcript_after_window", ["MP4", "M4A", "TIMELINE"]);
  await seedUnavailable(R_REVIVE_FAIL, "no_transcript_after_window", ["MP4", "M4A", "TIMELINE"]);
  await seedUnavailable(R_REVIVE_NOM4A, "no_transcript_after_window", ["MP4", "TIMELINE"]);
  await seedUnavailable(R_REVIVE_GONE, "recording_not_found");

  for (const id of ALL_IDS) {
    recordingShapes.set(uuidOf(id), { files: threeFileSet(uuidOf(id)) });
  }
  recordingShapes.set(uuidOf(R_NOAUDIO), {
    files: [
      { file_type: "MP4", download_url: `https://api.zoom.us/rec/${uuidOf(R_NOAUDIO)}/mp4` },
      { file_type: "TIMELINE", download_url: `https://api.zoom.us/rec/${uuidOf(R_NOAUDIO)}/timeline` },
    ],
  });
  recordingShapes.set(uuidOf(R_ZWS), { files: withZoomTranscript(uuidOf(R_ZWS)) });

  // ---- 1. Sweep fallback trigger + marker gate ----
  console.log("Scenario 1: sweep enqueues Rev AI fallback for audio-only recording");
  {
    const result = await processTranscriptBackfillRecord(R_QUICK);
    check("audio-but-no-transcript past window → 'revai_enqueued'", result === "revai_enqueued", result);
    const row = await getRow(R_QUICK);
    check("record stays 'pending' while the pipeline runs", row?.transcriptStatus === "pending", row?.transcriptStatus);
    const m = marker(row);
    check("marker claimed with state 'queued'", m?.state === "queued", m);
    check("marker attempts start at 0", m?.attempts === 0, m?.attempts);
    check("marker not flagged as revived", m?.revivedFromUnavailable === false, m?.revivedFromUnavailable);
    check("no terminal blob written", unavailableInfo(row) === null, unavailableInfo(row));
    const jobs = await queueRowsByDedupe(`zoom_revai:submit:${R_QUICK}`);
    check("durable submission job enqueued (work_queue row)", jobs.length === 1, jobs.length);
    check("job payload carries the recordId", (jobs[0]?.payload as any)?.recordId === R_QUICK, jobs[0]?.payload);
    check("job routed to the zoom_revai_transcription queue", jobs[0]?.queueName === "zoom_revai_transcription", jobs[0]?.queueName);

    const callsBefore = apiCalls.get(uuidOf(R_QUICK)) ?? 0;
    check("enqueue took exactly one live Zoom check", callsBefore === 1, callsBefore);
    const resweep = await processTranscriptBackfillRecord(R_QUICK);
    check("next sweep early-skips the in-flight record", resweep === "skipped", resweep);
    check(
      "early-skip spent NO extra Zoom API call (marker gate)",
      (apiCalls.get(uuidOf(R_QUICK)) ?? 0) === callsBefore,
      apiCalls.get(uuidOf(R_QUICK)),
    );
  }

  // ---- 2. Pipeline success via quick poll ----
  console.log("Scenario 2: Rev AI pipeline success (quick poll)");
  {
    revAiScriptByRecord.set(R_QUICK, {
      statuses: ["transcribed"],
      transcript: "Speaker 0    00:00:01    Generated words from the audio recording.",
    });
    const outcome = await processZoomRevAiTranscriptionJob(R_QUICK);
    check("processor completes via Rev AI", outcome === "completed:revai_transcript", outcome);
    const row = await getRow(R_QUICK);
    check("transcriptStatus is 'ready'", row?.transcriptStatus === "ready", row?.transcriptStatus);
    check(
      "contentText holds the generated transcript",
      !!row?.contentText && row.contentText.includes("Generated words from the audio recording"),
      row?.contentText,
    );
    const payload = row?.rawPayloadJson as any;
    check("provenance stamped: transcriptSource='revai_audio'", payload?.transcriptSource === ZOOM_TRANSCRIPT_SOURCE_REVAI, payload?.transcriptSource);
    check("hasTranscript flag set", payload?.hasTranscript === true, payload?.hasTranscript);
    const m = marker(row);
    check("marker completed with outcome revai_transcript", m?.state === "completed" && m?.outcome === "revai_transcript", m);
    check("marker kept its Rev AI job id", typeof m?.revJobId === "string" && m.revJobId.length > 0, m?.revJobId);
    check("marker consumed exactly one attempt", m?.attempts === 1, m?.attempts);
    check("exactly ONE Rev AI submission for the record", (revAiSubmissionsByRecord.get(R_QUICK) ?? 0) === 1, revAiSubmissionsByRecord.get(R_QUICK));
    check("processingStatus reset to 'pending' for downstream AI study", row?.processingStatus === "pending", row?.processingStatus);
    check(
      "analyze_communication handoff enqueued",
      await waitForQueueRow(`analyze_${R_QUICK}`),
    );
    check(
      "tmp audio file cleaned up",
      !nodeFs.existsSync(`${(await import("node:os")).tmpdir()}/zoom-revai-${R_QUICK}.m4a`),
    );

    // Idempotent re-run: transcript already present → no second submission.
    const rerun = await processZoomRevAiTranscriptionJob(R_QUICK);
    check("re-run skips (transcript already present)", rerun === "skipped:transcript_already_present", rerun);
    check("re-run made no extra Rev AI submission", (revAiSubmissionsByRecord.get(R_QUICK) ?? 0) === 1, revAiSubmissionsByRecord.get(R_QUICK));
    // Terminal rows drop out of sweeps entirely.
    const batch = new Set(await enqueueTranscriptBackfillBatch());
    check("ready record not enumerated by the sweep", !batch.has(R_QUICK));
  }

  // ---- 3. No audio file at all → terminal no_audio_file ----
  console.log("Scenario 3: no audio file → terminal no_audio_file");
  {
    const result = await processTranscriptBackfillRecord(R_NOAUDIO);
    check("no-audio recording → 'unavailable'", result === "unavailable", result);
    const row = await getRow(R_NOAUDIO);
    check("status is terminal 'unavailable'", row?.transcriptStatus === "unavailable", row?.transcriptStatus);
    const info = unavailableInfo(row);
    check("reason is no_audio_file", info?.reason === "no_audio_file", info);
    check(
      "observed fileTypes stored",
      JSON.stringify(info?.fileTypes) === JSON.stringify(["MP4", "TIMELINE"]),
      info?.fileTypes,
    );
    check("no Rev AI marker written", marker(row) === null, marker(row));
    check("no submission job enqueued", (await queueRowsByDedupe(`zoom_revai:submit:${R_NOAUDIO}`)).length === 0);
    check("no Rev AI submission made", (revAiSubmissionsByRecord.get(R_NOAUDIO) ?? 0) === 0);
  }

  // ---- 4. Rev AI job fails terminally ----
  console.log("Scenario 4: Rev AI failure → terminal transcription_failed");
  {
    const enq = await processTranscriptBackfillRecord(R_FAIL);
    check("fallback enqueued for the failing record", enq === "revai_enqueued", enq);
    revAiScriptByRecord.set(R_FAIL, {
      statuses: ["failed"],
      failure_detail: "no speech detected in audio",
    });
    const outcome = await processZoomRevAiTranscriptionJob(R_FAIL);
    check("processor reports terminal transcription failure", outcome === "terminal:transcription_failed", outcome);
    const row = await getRow(R_FAIL);
    check("status is terminal 'unavailable'", row?.transcriptStatus === "unavailable", row?.transcriptStatus);
    const info = unavailableInfo(row);
    check("reason is transcription_failed", info?.reason === "transcription_failed", info);
    check("failureDetail stored from Rev AI", info?.failureDetail === "no speech detected in audio", info?.failureDetail);
    const m = marker(row);
    check("marker failed with outcome revai_job_failed", m?.state === "failed" && m?.outcome === "revai_job_failed", m);

    const batch = new Set(await enqueueTranscriptBackfillBatch());
    check("terminal failure excluded from re-enumeration", !batch.has(R_FAIL));
    const revival = await reviveUnavailableRecordsForRevAi({ restrictToIds: [R_FAIL] });
    check(
      "terminal failure is NOT a revival candidate (no bounce)",
      revival.candidates === 0 && revival.revived === 0,
      revival,
    );
  }

  // ---- 5a. Zoom-delivered transcript short-circuits at sweep time ----
  console.log("Scenario 5a: Zoom transcript present at sweep → normal backfill");
  {
    const result = await processTranscriptBackfillRecord(R_ZWS);
    check("sweep backfills the Zoom transcript", result === "backfilled", result);
    const row = await getRow(R_ZWS);
    check("status 'ready' via Zoom transcript", row?.transcriptStatus === "ready", row?.transcriptStatus);
    check(
      "contentText parsed from the VTT",
      !!row?.contentText && row.contentText.includes("Hello from the Zoom transcript"),
      row?.contentText,
    );
    const payload = row?.rawPayloadJson as any;
    check("NO generated-provenance marker on a Zoom-delivered transcript", payload?.transcriptSource === undefined, payload?.transcriptSource);
    check("NO Rev AI pipeline marker", marker(row) === null, marker(row));
    check("zero Rev AI submissions", (revAiSubmissionsByRecord.get(R_ZWS) ?? 0) === 0);
    check("no submission job row", (await queueRowsByDedupe(`zoom_revai:submit:${R_ZWS}`)).length === 0);
  }

  // ---- 5b. Zoom transcript appears AFTER enqueue → Zoom wins inside the job ----
  console.log("Scenario 5b: Zoom transcript lands late → wins inside the pipeline job");
  {
    const enq = await processTranscriptBackfillRecord(R_ZWJ);
    check("fallback enqueued while Zoom had no transcript", enq === "revai_enqueued", enq);
    recordingShapes.set(uuidOf(R_ZWJ), { files: withZoomTranscript(uuidOf(R_ZWJ)) });
    const outcome = await processZoomRevAiTranscriptionJob(R_ZWJ);
    check("job completes via the Zoom transcript", outcome === "completed:zoom_transcript", outcome);
    const row = await getRow(R_ZWJ);
    check("status 'ready'", row?.transcriptStatus === "ready", row?.transcriptStatus);
    check(
      "contentText is Zoom's transcript",
      !!row?.contentText && row.contentText.includes("Hello from the Zoom transcript"),
      row?.contentText,
    );
    check("NO generated provenance (Zoom delivered it)", (row?.rawPayloadJson as any)?.transcriptSource === undefined);
    const m = marker(row);
    check("marker completed with outcome zoom_transcript_won", m?.state === "completed" && m?.outcome === "zoom_transcript_won", m);
    check("ZERO Rev AI submissions spent", (revAiSubmissionsByRecord.get(R_ZWJ) ?? 0) === 0, revAiSubmissionsByRecord.get(R_ZWJ));
  }

  // ---- 6. Revival of #3689-parked rows, exactly once ----
  console.log("Scenario 6: revival pass — exactly once, no bouncing");
  {
    const restrict = [R_REVIVE_OK, R_REVIVE_FAIL, R_REVIVE_NOM4A, R_REVIVE_GONE];
    const first = await reviveUnavailableRecordsForRevAi({ restrictToIds: restrict });
    check("only the two M4A/no_transcript_after_window rows are candidates", first.candidates === 2, first);
    check("both candidates revived (enqueued)", first.revived === 2, first);

    const okRow = await getRow(R_REVIVE_OK);
    check("revived row STAYS 'unavailable' while in flight (no pending bounce)", okRow?.transcriptStatus === "unavailable", okRow?.transcriptStatus);
    const okMarker = marker(okRow);
    check("revived marker queued + revivedFromUnavailable", okMarker?.state === "queued" && okMarker?.revivedFromUnavailable === true, okMarker);
    check("revival kept the terminal blob for now", unavailableInfo(okRow)?.reason === "no_transcript_after_window");
    const nom4aRow = await getRow(R_REVIVE_NOM4A);
    check("non-M4A row untouched", marker(nom4aRow) === null && nom4aRow?.transcriptStatus === "unavailable");
    const goneRow = await getRow(R_REVIVE_GONE);
    check("recording_not_found row untouched", marker(goneRow) === null && goneRow?.transcriptStatus === "unavailable");

    const second = await reviveUnavailableRecordsForRevAi({ restrictToIds: restrict });
    check("second pass finds NO candidates (fresh claims block)", second.candidates === 0 && second.revived === 0, second);

    // Success path: revived row gets a generated transcript.
    revAiScriptByRecord.set(R_REVIVE_OK, {
      statuses: ["transcribed"],
      transcript: "Revived generated transcript.",
    });
    const okOutcome = await processZoomRevAiTranscriptionJob(R_REVIVE_OK);
    check("revived record completes via Rev AI", okOutcome === "completed:revai_transcript", okOutcome);
    const okAfter = await getRow(R_REVIVE_OK);
    check("revived record now 'ready'", okAfter?.transcriptStatus === "ready", okAfter?.transcriptStatus);
    check("revived record carries generated provenance", (okAfter?.rawPayloadJson as any)?.transcriptSource === ZOOM_TRANSCRIPT_SOURCE_REVAI);
    check("stale terminal blob stripped on success", unavailableInfo(okAfter) === null, unavailableInfo(okAfter));

    // Failure path: revived row fails Rev AI → terminal, never revived again.
    revAiScriptByRecord.set(R_REVIVE_FAIL, {
      statuses: ["failed"],
      failure_detail: "audio corrupt",
    });
    const failOutcome = await processZoomRevAiTranscriptionJob(R_REVIVE_FAIL);
    check("revived record fails terminally", failOutcome === "terminal:transcription_failed", failOutcome);
    const failAfter = await getRow(R_REVIVE_FAIL);
    check("failed revival re-stamped as transcription_failed", unavailableInfo(failAfter)?.reason === "transcription_failed");
    const third = await reviveUnavailableRecordsForRevAi({ restrictToIds: restrict });
    check(
      "third pass: success is ready, failure re-reasoned — zero candidates (revive-once holds)",
      third.candidates === 0 && third.revived === 0,
      third,
    );
  }

  // ---- 7. Kill switch ----
  console.log("Scenario 7: kill switch parks records exactly like #3689");
  {
    await setKillSwitch("zoom_revai_transcription", true, "test");
    const result = await processTranscriptBackfillRecord(R_KILL);
    check("kill switch → sweep parks terminal no_transcript_after_window", result === "unavailable", result);
    const row = await getRow(R_KILL);
    const info = unavailableInfo(row);
    check("parked reason matches #3689 exactly", info?.reason === "no_transcript_after_window", info);
    check(
      "parked fileTypes include M4A (stays revivable)",
      Array.isArray(info?.fileTypes) && info.fileTypes.includes("M4A"),
      info?.fileTypes,
    );
    check("no marker while switched off", marker(row) === null, marker(row));
    check("no submission job while switched off", (await queueRowsByDedupe(`zoom_revai:submit:${R_KILL}`)).length === 0);

    const revival = await reviveUnavailableRecordsForRevAi({ restrictToIds: [R_KILL] });
    check("revival is a no-op under the kill switch", revival.candidates === 0 && revival.revived === 0 && !revival.capped, revival);
    const procOutcome = await processZoomRevAiTranscriptionJob(R_KILL);
    check("job processor refuses to run under the kill switch", procOutcome === "kill_switch:paused", procOutcome);

    // Release → the regular revival pass picks the parked row up.
    await setKillSwitch("zoom_revai_transcription", false, "test");
    const afterRelease = await reviveUnavailableRecordsForRevAi({ restrictToIds: [R_KILL] });
    check("after release, revival picks the parked row up", afterRelease.revived === 1, afterRelease);
    const revivedRow = await getRow(R_KILL);
    check("parked row now claimed for the pipeline", marker(revivedRow)?.state === "queued");
  }

  // ---- 8. Durable poll path ----
  console.log("Scenario 8: quick-poll exhaustion → durable delayed poll");
  {
    const enq = await processTranscriptBackfillRecord(R_POLL);
    check("fallback enqueued", enq === "revai_enqueued", enq);
    revAiScriptByRecord.set(R_POLL, {
      statuses: ["in_progress"],
      transcript: "Slow generated transcript.",
    });
    const outcome = await processZoomRevAiTranscriptionJob(R_POLL);
    check("still in progress after quick polls → 'submitted:polling'", outcome === "submitted:polling", outcome);
    const row = await getRow(R_POLL);
    const m = marker(row);
    check("marker submitted with revJobId persisted", m?.state === "submitted" && typeof m?.revJobId === "string", m);
    const pollJobs = await queueRowsByDedupe(`zoom_revai:poll:${R_POLL}:%`);
    check("delayed durable poll job enqueued", pollJobs.length === 1, pollJobs.length);
    check("poll job carries a future retryAt", !!pollJobs[0]?.retryAt && new Date(pollJobs[0].retryAt as any).getTime() > Date.now(), pollJobs[0]?.retryAt);

    // The Rev AI job finishes; the durable poll run completes the record.
    revAiJobs.get(m.revJobId)!.statuses = ["transcribed"];
    const pollOutcome = await processZoomRevAiTranscriptionJob(R_POLL);
    check("poll run completes the transcript", pollOutcome === "completed:revai_transcript", pollOutcome);
    const after = await getRow(R_POLL);
    check("record ready with generated provenance", after?.transcriptStatus === "ready" && (after?.rawPayloadJson as any)?.transcriptSource === ZOOM_TRANSCRIPT_SOURCE_REVAI);
    check("still exactly ONE Rev AI submission across both runs", (revAiSubmissionsByRecord.get(R_POLL) ?? 0) === 1, revAiSubmissionsByRecord.get(R_POLL));
  }

  // ---- 9. Empty transcript → terminal ----
  console.log("Scenario 9: empty Rev AI transcript → terminal transcription_failed");
  {
    const enq = await processTranscriptBackfillRecord(R_EMPTY);
    check("fallback enqueued", enq === "revai_enqueued", enq);
    revAiScriptByRecord.set(R_EMPTY, { statuses: ["transcribed"], transcript: "   " });
    const outcome = await processZoomRevAiTranscriptionJob(R_EMPTY);
    check("empty transcript goes terminal", outcome === "terminal:empty_transcript", outcome);
    const row = await getRow(R_EMPTY);
    const info = unavailableInfo(row);
    check(
      "reason transcription_failed / empty_transcript",
      info?.reason === "transcription_failed" && info?.failureDetail === "empty_transcript",
      info,
    );
    check("record NOT marked ready", row?.transcriptStatus === "unavailable", row?.transcriptStatus);
  }

  // ---- 10. Submission cap ----
  console.log("Scenario 10: per-window submission cap");
  {
    // Saturate the rolling window with filler submission-job rows (completed
    // status so no dispatcher ever leases them; any status counts).
    const fillers = Array.from({ length: 50 }, (_, i) => ({
      queueName: "zoom_revai_transcription",
      jobType: "zoom_revai_transcription",
      workloadClass: "repair",
      status: "completed",
      priority: 100,
      payload: {},
      dedupeKey: `zoom_revai:submit:capfill_${TAG}_${i}`,
    }));
    await workerDb.insert(workQueue).values(fillers as any);

    const result = await processTranscriptBackfillRecord(R_CAP);
    check("capped sweep defers the record ('skipped')", result === "skipped", result);
    const row = await getRow(R_CAP);
    check("capped record still 'pending' (next sweep retries)", row?.transcriptStatus === "pending", row?.transcriptStatus);
    check("no marker claimed while capped", marker(row) === null, marker(row));
    check("no submission job while capped", (await queueRowsByDedupe(`zoom_revai:submit:${R_CAP}`)).length === 0);

    const revival = await reviveUnavailableRecordsForRevAi({ restrictToIds: [R_CAP] });
    check("revival reports capped", revival.capped === true && revival.revived === 0, revival);

    await workerDb.delete(workQueue).where(like(workQueue.dedupeKey, `zoom_revai:submit:capfill_${TAG}_%`));
  }
} finally {
  try {
    await workerDb
      .delete(rawCommunicationRecords)
      .where(inArray(rawCommunicationRecords.id, ALL_IDS));
  } catch (e) {
    console.error("cleanup: failed to delete seeded rows", e);
  }
  try {
    await workerDb.delete(workQueue).where(like(workQueue.dedupeKey, `%${TAG}%`));
  } catch (e) {
    console.error("cleanup: failed to delete tagged work_queue rows", e);
  }
  try {
    await restoreZoomSettings(settingsSnap);
  } catch (e) {
    console.error("cleanup: failed to restore zoom settings", e);
  }
  try {
    if (revAiKillSwitchSnap === null) {
      await setKillSwitch("zoom_revai_transcription", false, "test");
      await storage.deleteSystemSetting(REVAI_KILL_SWITCH_KEY);
    } else {
      await setKillSwitch(
        "zoom_revai_transcription",
        revAiKillSwitchSnap === "true",
        "test",
      );
    }
  } catch (e) {
    console.error("cleanup: failed to restore Rev AI kill switch", e);
  }
  global.fetch = originalFetch;
}

console.log(`\n✅ zoom-revai-fallback: all ${passed} assertions passed`);
