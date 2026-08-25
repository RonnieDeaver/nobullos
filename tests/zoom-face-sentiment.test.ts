/* test-registration
{
  "name": "Zoom client face sentiment — planning, enumeration, processor outcomes (Task #3702)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3702: Zoom client face-sentiment — frame-sampling plan, strict vision-reply parsing (conservative client_visible=false fallback), opt-in default-OFF gating, enumeration terminal-state filters, batch cap, and every per-record outcome (no_video/failed/attempt budget/ idempotent skips) with fully injected deps: no Zoom API, no ffmpeg, no vision calls; isolated schema, fast. A drift here either burns vision tokens on re-analysis (idempotency) or stores bogus readings for camera-off meetings (conservative fallback).",
  "tier": "small"
}
test-registration */
/**
 * Task #3702 — Zoom client face-sentiment analysis: pure planning/parsing
 * helpers + the real enumeration, sweep, and per-record processor against an
 * isolated Postgres schema with fully injected external-world deps (no Zoom
 * API, no ffmpeg, no vision calls).
 *
 * Covered:
 *   A. planSampleTimestamps — count clamping (4..12), 5%..95% window, order.
 *   B. parseVisionOutcome — strict-JSON validation, conservative
 *      client_visible=false passthrough, frame-index→atSec mapping, invalid
 *      sentiment → "unclear", out-of-range/invisible frame dropping, notable
 *      moment caps, garbage → throws.
 *   C. pickBestMp4 — gallery/speaker preference, non-MP4 and URL-less
 *      filtering.
 *   D. getZoomFaceSentimentBadge — none/analyzed/no_video/failed copy states.
 *   E. Feature is opt-in: isZoomFaceSentimentEnabled() is FALSE by default
 *      (kill-switch default, no override in this env), and a disabled sweep
 *      enqueues nothing.
 *   F. enumerateFaceSentimentCandidates — includes never-analyzed + retryable
 *      failed rows; excludes analyzed/no_video/exhausted/old/non-zoom; newest
 *      first; sweep batch cap truncates.
 *   G. processZoomFaceSentimentRecord — every outcome: skipped_missing /
 *      skipped_not_zoom / skipped_terminal (deps untouched, stored `at`
 *      unchanged) / skipped_exhausted / skipped_disabled; recordingCount=0 →
 *      no_video without an API call; no meetingUuid → parked failed;
 *      recording-gone → no_video/recording_unavailable; auth-gate failure →
 *      failed WITHOUT consuming an attempt; no-MP4 set → no_video with
 *      fileTypes; download failures → attempts 1→2→3 then skipped_exhausted;
 *      duration fallback to ingest minutes; client-not-visible → explicit
 *      no_video/client_not_visible; happy path persists the full analyzed
 *      shape via jsonb merge (sibling payload keys preserved).
 *
 * Runs in an isolated schema (raw_communication_records cloned, getDb()
 * pinned) so assertions are exact-set and nothing touches shared dev data;
 * kill switches are only READ (never written) — gating is exercised through
 * the injectable isEnabled seam.
 */
import assert from "node:assert/strict";
import type { FaceSentimentDeps } from "../server/services/zoomFaceSentiment";

const TAG = `t3702_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const { runInIsolatedSchema } = await import("./db-sandbox");
const { rawCommunicationRecords } = await import("../shared/models/communications");
const {
  planSampleTimestamps,
  parseVisionOutcome,
  pickBestMp4,
  enumerateFaceSentimentCandidates,
  runZoomFaceSentimentSweep,
  processZoomFaceSentimentRecord,
  isZoomFaceSentimentEnabled,
} = await import("../server/services/zoomFaceSentiment");
const {
  ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS,
  ZOOM_FACE_SENTIMENT_VERSION,
  formatSentimentTimestamp,
  getZoomFaceSentimentBadge,
} = await import("../shared/zoomSentiment");

// ── A. planSampleTimestamps ───────────────────────────────────────────────
console.log("\n— planSampleTimestamps —");
{
  assert.deepEqual(planSampleTimestamps(0), [], "zero duration → no samples");
  assert.deepEqual(planSampleTimestamps(-5), [], "negative duration → no samples");
  assert.deepEqual(planSampleTimestamps(NaN), [], "NaN duration → no samples");

  const short = planSampleTimestamps(600); // 10 min → 600/240≈3 → clamp to 4
  assert.equal(short.length, 4, `10-min call samples 4 frames, got ${short.length}`);
  assert.ok(Math.abs(short[0] - 30) < 0.01, `first sample at 5% (30s), got ${short[0]}`);
  assert.ok(Math.abs(short[3] - 570) < 0.01, `last sample at 95% (570s), got ${short[3]}`);

  const hour = planSampleTimestamps(3600); // 15 raw → clamp 12
  assert.equal(hour.length, 12, `60-min call clamps to 12 frames, got ${hour.length}`);
  assert.ok(Math.abs(hour[0] - 180) < 0.01, `hour-call first sample 180s, got ${hour[0]}`);
  assert.ok(Math.abs(hour[11] - 3420) < 0.01, `hour-call last sample 3420s, got ${hour[11]}`);

  const mid = planSampleTimestamps(1200); // 20 min → exactly 5
  assert.equal(mid.length, 5, `20-min call samples 5 frames, got ${mid.length}`);
  for (let i = 1; i < mid.length; i++) {
    assert.ok(mid[i] > mid[i - 1], "samples strictly increasing");
  }
  console.log("  ✓ clamps to [4,12] frames evenly across 5%–95%");
}

// ── B. parseVisionOutcome ─────────────────────────────────────────────────
console.log("\n— parseVisionOutcome —");
{
  assert.throws(() => parseVisionOutcome("not json at all", [10]), /not valid JSON/);
  assert.throws(() => parseVisionOutcome("42", [10]), /not an object/);
  assert.throws(
    () => parseVisionOutcome(JSON.stringify({ client_visible: true, overall: "ecstatic" }), [10]),
    /overall sentiment invalid/,
    "unknown overall enum must throw, never store a made-up value",
  );

  const invisible = parseVisionOutcome(
    JSON.stringify({
      client_visible: false,
      client_identification: { description: "screen share only", confidence: "HIGH" },
    }),
    [10, 20],
  );
  assert.equal(invisible.clientVisible, false, "client_visible=false passthrough");
  assert.equal(invisible.clientIdentification.confidence, "high", "confidence case-normalized");
  assert.equal(invisible.overall, undefined, "no sentiment fields when invisible");

  const atSecs = [30, 330, 630, 930];
  const full = parseVisionOutcome(
    JSON.stringify({
      client_visible: true,
      client_identification: { description: "name label 'Pat (Acme)'", confidence: "medium" },
      overall: "Mixed",
      summary: "Engaged early, visibly frustrated near the end.",
      frames: [
        { frame: 1, client_visible: true, sentiment: "positive", note: "smiling" },
        { frame: 2, client_visible: false }, // camera off mid-call → dropped
        { frame: 3, client_visible: true, sentiment: "grumpy" }, // bad enum → unclear
        { frame: 4, client_visible: true, sentiment: "negative", note: "arms crossed" },
        { frame: 99, client_visible: true, sentiment: "positive" }, // out of range → dropped
        { frame: 0, client_visible: true, sentiment: "positive" }, // out of range → dropped
      ],
      notable_moments: [
        { frame: 4, note: "visible frustration during pricing discussion" },
        { frame: 2, note: "   " }, // empty note → dropped
        { frame: 77, note: "phantom frame" }, // out of range → dropped
      ],
    }),
    atSecs,
  );
  assert.equal(full.clientVisible, true);
  assert.equal(full.overall, "mixed", "overall lower-cased + validated");
  assert.equal(full.framesWithClientVisible, 3, "counts only client-visible in-range frames");
  assert.deepEqual(
    full.timeline!.map((p) => [p.atSec, p.sentiment]),
    [[30, "positive"], [630, "unclear"], [930, "negative"]],
    "timeline maps 1-based frame index → atSec, invalid sentiment → unclear, invisible/out-of-range dropped",
  );
  assert.equal(full.timeline![0].note, "smiling");
  assert.deepEqual(
    full.notableMoments!.map((m) => [m.atSec, m.note]),
    [[930, "visible frustration during pricing discussion"]],
    "moments keep only in-range frames with real notes",
  );
  console.log("  ✓ validates enums, maps frame indices, drops junk conservatively");
}

// ── C. pickBestMp4 ────────────────────────────────────────────────────────
console.log("\n— pickBestMp4 —");
{
  assert.equal(pickBestMp4([]), null, "empty set → null");
  assert.equal(
    pickBestMp4([{ file_type: "M4A", download_url: "u" }, { file_type: "TIMELINE", download_url: "u" }]),
    null,
    "no MP4 → null",
  );
  assert.equal(
    pickBestMp4([{ file_type: "MP4" }]),
    null,
    "MP4 without download_url → null",
  );
  const gallery = { file_type: "MP4", recording_type: "gallery_view", download_url: "g" };
  const speaker = { file_type: "MP4", recording_type: "shared_screen_with_speaker_view", download_url: "s" };
  const misc = { file_type: "MP4", recording_type: "audio_only_view", download_url: "m" };
  assert.equal(pickBestMp4([speaker, gallery]), gallery, "prefers gallery_view (most face tiles)");
  assert.equal(pickBestMp4([misc, speaker]), speaker, "falls back down the preference order");
  assert.equal(pickBestMp4([misc]), misc, "otherwise first MP4");
  console.log("  ✓ prefers face-tile-rich views, requires a download URL");
}

// ── D. badge + timestamp helpers ──────────────────────────────────────────
console.log("\n— getZoomFaceSentimentBadge / formatSentimentTimestamp —");
{
  assert.equal(formatSentimentTimestamp(0), "0:00");
  assert.equal(formatSentimentTimestamp(65), "1:05");
  assert.equal(formatSentimentTimestamp(3665), "1:01:05");

  assert.equal(getZoomFaceSentimentBadge(null).state, "none", "absent result → none");
  assert.equal(getZoomFaceSentimentBadge({} as any).state, "none", "statusless → none");
  assert.equal(getZoomFaceSentimentBadge({ status: "analyzed" }).state, "analyzed");

  const noFile = getZoomFaceSentimentBadge({ status: "no_video", reason: "no_video_file", fileTypes: ["M4A", "TIMELINE"] });
  assert.equal(noFile.state, "no_video");
  assert.ok(noFile.detail!.includes("M4A, TIMELINE"), `no_video_file detail lists file types: ${noFile.detail}`);
  assert.ok(
    getZoomFaceSentimentBadge({ status: "no_video", reason: "recording_unavailable" }).detail!.includes("no longer exists"),
    "recording_unavailable copy",
  );
  assert.ok(
    getZoomFaceSentimentBadge({ status: "no_video", reason: "client_not_visible" }).detail!.includes("camera was off"),
    "client_not_visible copy mentions camera-off",
  );

  const retrying = getZoomFaceSentimentBadge({ status: "failed", attempts: 1, error: "boom" });
  assert.ok(retrying.detail!.includes("will retry"), `non-exhausted failure says it will retry: ${retrying.detail}`);
  const parked = getZoomFaceSentimentBadge({ status: "failed", attempts: ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS, error: "boom" });
  assert.ok(parked.detail!.includes("won't retry"), `exhausted failure says it won't retry: ${parked.detail}`);
  console.log("  ✓ honest copy for every state");
}

// ── E. opt-in default ─────────────────────────────────────────────────────
console.log("\n— feature switch default —");
{
  // Brand-new switch, no override row exists in this environment: the
  // feature must be OFF by default (vision analysis costs real tokens).
  assert.equal(isZoomFaceSentimentEnabled(), false, "zoom_face_sentiment_enabled defaults OFF");

  const enqueued: string[] = [];
  const summary = await runZoomFaceSentimentSweep({
    isEnabled: () => false,
    enqueue: async (id) => { enqueued.push(id); },
  });
  assert.deepEqual(
    { skipped: summary.skipped, reason: summary.reason, enqueued: summary.enqueued },
    { skipped: true, reason: "disabled", enqueued: 0 },
    "disabled sweep short-circuits",
  );
  assert.equal(enqueued.length, 0, "disabled sweep never enqueues");
  console.log("  ✓ opt-in: disabled by default, disabled sweep enqueues nothing");
}

// ── F+G. DB-backed enumeration / sweep / processor ────────────────────────
console.log("\n— isolated-schema enumeration + processor —");

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600 * 1000);
}
function daysAgo(d: number): Date {
  return hoursAgo(d * 24);
}

/** Deps stub where everything throws unless overridden — proves untouched paths. */
function makeDeps(overrides: Partial<FaceSentimentDeps> = {}): FaceSentimentDeps & {
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {
    fetchRecordingSet: 0, downloadVideo: 0, probeDurationSec: 0, extractFrames: 0, analyzeFrames: 0,
  };
  const wrap = <K extends keyof FaceSentimentDeps>(k: K, fn: any): any =>
    (...args: any[]) => { calls[k as string]++; return fn(...args); };
  const base: FaceSentimentDeps = {
    fetchRecordingSet: async () => { throw new Error("fetchRecordingSet not expected"); },
    downloadVideo: async () => { throw new Error("downloadVideo not expected"); },
    probeDurationSec: () => { throw new Error("probeDurationSec not expected"); },
    extractFrames: async () => { throw new Error("extractFrames not expected"); },
    analyzeFrames: async () => { throw new Error("analyzeFrames not expected"); },
    now: () => new Date("2026-08-03T12:00:00.000Z"),
    ...overrides,
  };
  return {
    calls,
    now: base.now,
    fetchRecordingSet: wrap("fetchRecordingSet", base.fetchRecordingSet),
    downloadVideo: wrap("downloadVideo", base.downloadVideo),
    probeDurationSec: wrap("probeDurationSec", base.probeDurationSec),
    extractFrames: wrap("extractFrames", base.extractFrames),
    analyzeFrames: wrap("analyzeFrames", base.analyzeFrames),
  };
}

const ENABLED = { isEnabled: () => true };

await runInIsolatedSchema(
  async ({ db }) => {
    const ID = (s: string) => `${TAG}_${s}`;
    const zoomRow = (suffix: string, ts: Date, payload: any, extra: any = {}) => ({
      id: ID(suffix),
      sourceType: "zoom",
      sourceSubtype: "zoom_meeting",
      title: `Meeting ${suffix}`,
      timestamp: ts,
      rawPayloadJson: payload,
      ...extra,
    });

    await db.insert(rawCommunicationRecords).values([
      // Eligible: never analyzed, recent, has recording files.
      zoomRow("new", hoursAgo(1), { meetingUuid: `${TAG}_uuid_new`, recordingCount: 2, duration: 30, keep: "me" }),
      // Eligible: failed with retry budget left.
      zoomRow("retry", hoursAgo(2), {
        meetingUuid: `${TAG}_uuid_retry`, recordingCount: 2, duration: 20,
        zoomFaceSentiment: { status: "failed", attempts: 1, error: "x", version: 1, at: "2026-08-01T00:00:00.000Z" },
      }),
      // Terminal: exhausted failure.
      zoomRow("exhausted", hoursAgo(3), {
        meetingUuid: `${TAG}_uuid_exhausted`, recordingCount: 2,
        zoomFaceSentiment: { status: "failed", attempts: ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS, error: "x", version: 1, at: "2026-08-01T00:00:00.000Z" },
      }),
      // Terminal: analyzed.
      zoomRow("analyzed", hoursAgo(4), {
        meetingUuid: `${TAG}_uuid_analyzed`, recordingCount: 2,
        zoomFaceSentiment: { status: "analyzed", overall: "positive", version: 1, at: "2026-08-01T00:00:00.000Z" },
      }),
      // Terminal: no_video.
      zoomRow("novideo", hoursAgo(5), {
        meetingUuid: `${TAG}_uuid_novideo`, recordingCount: 0,
        zoomFaceSentiment: { status: "no_video", reason: "no_video_file", version: 1, at: "2026-08-01T00:00:00.000Z" },
      }),
      // Outside the lookback window.
      zoomRow("old", daysAgo(45), { meetingUuid: `${TAG}_uuid_old`, recordingCount: 2 }),
      // Not a zoom record.
      { id: ID("front"), sourceType: "front_email", title: "An email", timestamp: hoursAgo(1), rawPayloadJson: {} },
      // Zero recordings at ingest, no sentiment yet → eligible (cheap no_video).
      zoomRow("norec", hoursAgo(6), { meetingUuid: `${TAG}_uuid_norec`, recordingCount: 0 }),
      // recordingCount>0 but no meetingUuid → eligible (parks as failed).
      zoomRow("nouuid", hoursAgo(7), { recordingCount: 1 }),
    ]);

    const readSentiment = async (suffix: string): Promise<any> => {
      const res: any = await db.execute(
        (await import("drizzle-orm")).sql`
          SELECT raw_payload_json FROM raw_communication_records WHERE id = ${ID(suffix)}
        `,
      );
      const rows = Array.isArray(res) ? res : res?.rows ?? [];
      return rows[0]?.raw_payload_json ?? null;
    };

    // ── F. enumeration ────────────────────────────────────────────────────
    {
      const ids = await enumerateFaceSentimentCandidates(50, { lookbackDays: 30 });
      assert.deepEqual(
        ids,
        [ID("new"), ID("retry"), ID("norec"), ID("nouuid")],
        `enumeration = eligible zoom rows newest-first, got ${JSON.stringify(ids)}`,
      );
      console.log("  ✓ enumeration includes new + retryable, excludes terminal/old/non-zoom, newest first");

      const capped = await enumerateFaceSentimentCandidates(1, { lookbackDays: 30 });
      assert.deepEqual(capped, [ID("new")], "LIMIT truncates to newest");

      const enqueued: string[] = [];
      const summary = await runZoomFaceSentimentSweep({
        isEnabled: () => true,
        enqueue: async (id) => { enqueued.push(id); },
        batchCap: 2,
        lookbackDays: 30,
      });
      assert.deepEqual(
        { skipped: summary.skipped, candidates: summary.candidates, enqueued: summary.enqueued },
        { skipped: false, candidates: 2, enqueued: 2 },
        "sweep respects the batch cap",
      );
      assert.deepEqual(enqueued, [ID("new"), ID("retry")], "cap keeps the newest candidates");
      console.log("  ✓ sweep batch cap enqueues only the newest N");
    }

    // ── G. processor outcomes ─────────────────────────────────────────────
    {
      // Disabled gate re-checked at execution time; nothing persisted.
      const depsDisabled = makeDeps();
      assert.equal(
        await processZoomFaceSentimentRecord(ID("new"), depsDisabled, { isEnabled: () => false }),
        "skipped_disabled",
      );
      assert.equal((await readSentiment("new")).zoomFaceSentiment, undefined, "disabled run persists nothing");
      assert.equal(depsDisabled.calls.fetchRecordingSet, 0, "disabled run never calls Zoom");

      assert.equal(await processZoomFaceSentimentRecord(ID("missing"), makeDeps(), ENABLED), "skipped_missing");
      assert.equal(await processZoomFaceSentimentRecord(ID("front"), makeDeps(), ENABLED), "skipped_not_zoom");

      const depsTerminal = makeDeps();
      assert.equal(await processZoomFaceSentimentRecord(ID("analyzed"), depsTerminal, ENABLED), "skipped_terminal");
      assert.equal(await processZoomFaceSentimentRecord(ID("novideo"), depsTerminal, ENABLED), "skipped_terminal");
      assert.equal(await processZoomFaceSentimentRecord(ID("exhausted"), depsTerminal, ENABLED), "skipped_exhausted");
      assert.equal(depsTerminal.calls.fetchRecordingSet, 0, "terminal/exhausted rows never reach the API");
      assert.equal(
        (await readSentiment("analyzed")).zoomFaceSentiment.at,
        "2026-08-01T00:00:00.000Z",
        "terminal skip leaves the stored result untouched (idempotent)",
      );
      console.log("  ✓ skip paths: disabled/missing/not-zoom/terminal/exhausted, deps untouched");

      // recordingCount=0 → explicit no_video WITHOUT an API call.
      const depsNoRec = makeDeps();
      assert.equal(await processZoomFaceSentimentRecord(ID("norec"), depsNoRec, ENABLED), "no_video");
      assert.equal(depsNoRec.calls.fetchRecordingSet, 0, "zero-recording rows skip the API entirely");
      const norec = (await readSentiment("norec")).zoomFaceSentiment;
      assert.equal(norec.status, "no_video");
      assert.equal(norec.reason, "no_video_file");
      assert.equal(norec.version, ZOOM_FACE_SENTIMENT_VERSION);
      assert.equal(norec.at, "2026-08-03T12:00:00.000Z", "stamped with injected now()");

      // recordingCount>0 but no identifier → parked failed (budget consumed).
      assert.equal(await processZoomFaceSentimentRecord(ID("nouuid"), makeDeps(), ENABLED), "failed");
      const nouuid = (await readSentiment("nouuid")).zoomFaceSentiment;
      assert.equal(nouuid.status, "failed");
      assert.equal(nouuid.attempts, ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS, "unfixable rows park immediately");
      console.log("  ✓ no-recordings → cheap no_video; no-uuid → parked failed");

      // Recording gone from Zoom (404/3301) → terminal no_video.
      const depsGone = makeDeps({
        fetchRecordingSet: async () => { throw new Error("Zoom API error: 404 {\"code\":3301}"); },
      });
      assert.equal(await processZoomFaceSentimentRecord(ID("retry"), depsGone, ENABLED), "no_video");
      const gone = (await readSentiment("retry")).zoomFaceSentiment;
      assert.equal(gone.reason, "recording_unavailable");
      // Re-run: now terminal.
      assert.equal(await processZoomFaceSentimentRecord(ID("retry"), makeDeps(), ENABLED), "skipped_terminal");
      console.log("  ✓ recording-gone → terminal no_video/recording_unavailable");

      // Auth-gate failure must NOT consume an attempt.
      const authErr = Object.assign(new Error("Zoom integration disconnected"), { name: "ZoomPermanentError" });
      const depsAuth = makeDeps({ fetchRecordingSet: async () => { throw authErr; } });
      assert.equal(await processZoomFaceSentimentRecord(ID("new"), depsAuth, ENABLED), "failed");
      const afterAuth = (await readSentiment("new")).zoomFaceSentiment;
      assert.equal(afterAuth.status, "failed");
      assert.equal(afterAuth.attempts, 0, "auth outage consumes no retry budget");
      assert.ok(afterAuth.error.includes("reconnect required"), `auth failure names the fix: ${afterAuth.error}`);
      assert.equal((await readSentiment("new")).keep, "me", "jsonb merge preserves sibling payload keys");

      // Transient failures consume attempts 1→2→3, then the row parks.
      for (let expected = 1; expected <= ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS; expected++) {
        const depsFail = makeDeps({
          fetchRecordingSet: async () => ({
            recording_files: [{ file_type: "MP4", recording_type: "gallery_view", download_url: "https://zoom.example/dl" }],
          }),
          downloadVideo: async () => { throw new Error("ECONNRESET mid-download"); },
        });
        assert.equal(await processZoomFaceSentimentRecord(ID("new"), depsFail, ENABLED), "failed");
        assert.equal(
          (await readSentiment("new")).zoomFaceSentiment.attempts,
          expected,
          `transient failure #${expected} consumes one attempt`,
        );
        const stillEligible = await enumerateFaceSentimentCandidates(50, { lookbackDays: 30 });
        assert.equal(
          stillEligible.includes(ID("new")),
          expected < ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS,
          `row ${expected < ZOOM_FACE_SENTIMENT_MAX_ATTEMPTS ? "stays" : "drops out of"} enumeration after failure #${expected}`,
        );
      }
      const depsAfterPark = makeDeps();
      assert.equal(await processZoomFaceSentimentRecord(ID("new"), depsAfterPark, ENABLED), "skipped_exhausted");
      assert.equal(depsAfterPark.calls.fetchRecordingSet, 0, "parked rows never reach the API again");
      console.log("  ✓ failure attempts 1→2→3 then parked, enumeration follows");
    }

    // ── G2. happy path + client-not-visible + no-MP4 + duration fallback ──
    {
      await db.insert(rawCommunicationRecords).values([
        {
          id: ID("happy"),
          sourceType: "zoom",
          sourceSubtype: "zoom_recording",
          title: "QBR with Acme",
          timestamp: hoursAgo(1),
          participantsJson: [
            { name: "Alex Team", email: "alex@nobull.com", role: "host" },
            { name: "Sam Internal", email: "sam@nobull.com", role: "participant" },
            { name: "Pat Client", email: "pat@acme.com", role: "external" },
          ],
          rawPayloadJson: { meetingUuid: `${TAG}_uuid_happy`, recordingCount: 3, duration: 20, otherKey: 1 },
        },
      ]);

      const recordingSet = {
        recording_files: [
          { file_type: "M4A", download_url: "https://zoom.example/a" },
          { file_type: "MP4", recording_type: "shared_screen_with_speaker_view", download_url: "https://zoom.example/spk" },
          { file_type: "MP4", recording_type: "gallery_view", download_url: "https://zoom.example/gal" },
        ],
      };
      const seenDownloads: string[] = [];
      let analyzeInput: any = null;
      const depsHappy = makeDeps({
        fetchRecordingSet: async () => recordingSet,
        downloadVideo: async (url) => { seenDownloads.push(url); },
        probeDurationSec: () => 1200,
        extractFrames: async (_video, timestamps, _outDir) =>
          timestamps.map((ts) => ({ atSec: ts, filePath: `/tmp/fake-${ts}.jpg` })),
        analyzeFrames: async (input) => {
          analyzeInput = input;
          return {
            model: "test-vision-model",
            outcome: {
              clientVisible: true,
              clientIdentification: { description: "gallery tile labeled 'Pat Client'", confidence: "high" as const },
              overall: "mixed" as const,
              summary: "Warm start, visible frustration at the end.",
              timeline: input.frames.map((f: any, i: number) => ({
                atSec: f.atSec,
                sentiment: i === input.frames.length - 1 ? ("negative" as const) : ("positive" as const),
              })),
              notableMoments: [{ atSec: input.frames[input.frames.length - 1].atSec, note: "frown during pricing" }],
              framesWithClientVisible: input.frames.length,
            },
          };
        },
      });

      assert.equal(await processZoomFaceSentimentRecord(ID("happy"), depsHappy, ENABLED), "analyzed");
      assert.deepEqual(seenDownloads, ["https://zoom.example/gal"], "downloads the gallery-view MP4");
      assert.equal(analyzeInput.meeting.topic, "QBR with Acme");
      assert.deepEqual(analyzeInput.meeting.teamParticipants, ["Alex Team", "Sam Internal"], "host+internal = team side");
      assert.deepEqual(analyzeInput.meeting.clientParticipants, ["Pat Client"], "external = client side");
      assert.equal(analyzeInput.frames.length, 5, "20-min call → 5 sampled frames");

      const happyPayload = await readSentiment("happy");
      assert.equal(happyPayload.otherKey, 1, "merge preserves other payload keys");
      const happy = happyPayload.zoomFaceSentiment;
      assert.equal(happy.status, "analyzed");
      assert.equal(happy.overall, "mixed");
      assert.equal(happy.version, ZOOM_FACE_SENTIMENT_VERSION);
      assert.equal(happy.model, "test-vision-model");
      assert.equal(happy.framesSampled, 5);
      assert.equal(happy.framesWithClientVisible, 5);
      assert.equal(happy.timeline.length, 5);
      assert.equal(happy.timeline[4].sentiment, "negative");
      assert.equal(happy.notableMoments.length, 1);
      assert.equal(happy.clientIdentification.confidence, "high");
      assert.ok(happy.summary.includes("frustration"), "summary stored");

      // Idempotent: re-run is a terminal skip, deps untouched, `at` unchanged.
      const depsRerun = makeDeps();
      assert.equal(await processZoomFaceSentimentRecord(ID("happy"), depsRerun, ENABLED), "skipped_terminal");
      assert.equal(depsRerun.calls.fetchRecordingSet + depsRerun.calls.downloadVideo, 0);
      assert.equal((await readSentiment("happy")).zoomFaceSentiment.at, happy.at, "re-run leaves result byte-identical");
      console.log("  ✓ happy path: gallery MP4 → frames → vision → full analyzed shape, idempotent");

      // Client not visible → explicit no_video/client_not_visible.
      await db.insert(rawCommunicationRecords).values([
        zoomRow("camoff", hoursAgo(1), { meetingUuid: `${TAG}_uuid_camoff`, recordingCount: 1, duration: 20 }),
      ]);
      const depsCamOff = makeDeps({
        fetchRecordingSet: async () => recordingSet,
        downloadVideo: async () => {},
        probeDurationSec: () => 1200,
        extractFrames: async (_v, timestamps) => timestamps.map((ts) => ({ atSec: ts, filePath: `/tmp/f${ts}.jpg` })),
        analyzeFrames: async () => ({
          model: "test-vision-model",
          outcome: {
            clientVisible: false,
            clientIdentification: { description: "only a shared slide deck is visible", confidence: "low" as const },
          },
        }),
      });
      assert.equal(await processZoomFaceSentimentRecord(ID("camoff"), depsCamOff, ENABLED), "no_video");
      const camoff = (await readSentiment("camoff")).zoomFaceSentiment;
      assert.equal(camoff.reason, "client_not_visible");
      assert.equal(camoff.detail, "only a shared slide deck is visible", "conservative fallback stores what WAS visible");
      assert.equal(camoff.framesSampled, 5);
      console.log("  ✓ camera-off/screen-share-only → explicit no_video/client_not_visible");

      // Recording set with no MP4 → no_video with deduped fileTypes.
      await db.insert(rawCommunicationRecords).values([
        zoomRow("audioonly", hoursAgo(1), { meetingUuid: `${TAG}_uuid_audio`, recordingCount: 2 }),
      ]);
      const depsAudio = makeDeps({
        fetchRecordingSet: async () => ({
          recording_files: [
            { file_type: "M4A", download_url: "u1" },
            { file_type: "TIMELINE", download_url: "u2" },
            { file_type: "M4A", download_url: "u3" },
          ],
        }),
      });
      assert.equal(await processZoomFaceSentimentRecord(ID("audioonly"), depsAudio, ENABLED), "no_video");
      const audio = (await readSentiment("audioonly")).zoomFaceSentiment;
      assert.equal(audio.reason, "no_video_file");
      assert.deepEqual(audio.fileTypes, ["M4A", "TIMELINE"], "observed file types deduped");

      // Duration fallback: ffprobe fails → ingest minutes drive the plan;
      // both missing → failed.
      await db.insert(rawCommunicationRecords).values([
        zoomRow("fallbackdur", hoursAgo(1), { meetingUuid: `${TAG}_uuid_fb`, recordingCount: 1, duration: 40 }),
        zoomRow("nodur", hoursAgo(1), { meetingUuid: `${TAG}_uuid_nodur`, recordingCount: 1 }),
      ]);
      let fallbackTimestamps: number[] = [];
      const depsFallback = makeDeps({
        fetchRecordingSet: async () => recordingSet,
        downloadVideo: async () => {},
        probeDurationSec: () => null,
        extractFrames: async (_v, timestamps) => {
          fallbackTimestamps = timestamps;
          return timestamps.map((ts) => ({ atSec: ts, filePath: `/tmp/f${ts}.jpg` }));
        },
        analyzeFrames: async (input) => ({
          model: "m",
          outcome: {
            clientVisible: true,
            clientIdentification: { description: "d", confidence: "medium" as const },
            overall: "neutral" as const,
            summary: "s",
            timeline: [],
            notableMoments: [],
            framesWithClientVisible: input.frames.length,
          },
        }),
      });
      assert.equal(await processZoomFaceSentimentRecord(ID("fallbackdur"), depsFallback, ENABLED), "analyzed");
      assert.deepEqual(fallbackTimestamps, planSampleTimestamps(40 * 60), "ffprobe-null falls back to ingest duration");

      const depsNoDur = makeDeps({
        fetchRecordingSet: async () => recordingSet,
        downloadVideo: async () => {},
        probeDurationSec: () => null,
      });
      assert.equal(await processZoomFaceSentimentRecord(ID("nodur"), depsNoDur, ENABLED), "failed");
      assert.ok(
        (await readSentiment("nodur")).zoomFaceSentiment.error.includes("duration"),
        "duration-less video fails with a reviewable reason",
      );
      assert.equal(depsNoDur.calls.extractFrames, 0, "no frames attempted without a duration");
      console.log("  ✓ no-MP4 fileTypes, ffprobe fallback to ingest minutes, honest duration failure");
    }
  },
  { tables: ["raw_communication_records"], pinGetDbForCrossAsync: true },
);

console.log(
  "\nzoom-face-sentiment: planning/parsing are conservative, enumeration/sweep respect opt-in + caps + terminal states, and every processor outcome persists a reviewable status.",
);

// Close the pg pools explicitly so a bare `npx tsx` run (without the
// harness's NODE_ENV=test, which sets idleTimeoutMillis=0) still exits
// instead of hanging on the pool's ref'd idle-reaper timer.
const { closeDbPools } = await import("../server/db");
await closeDbPools().catch(() => undefined);
