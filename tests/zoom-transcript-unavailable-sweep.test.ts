/* test-registration
{
  "name": "Zoom transcript unavailable sweep (Task #3689)",
  "regression": true,
  "sweepOnlyReason": "Task #3689 — window-lapse terminal transition (pending→unavailable): seeds real raw_communication_records rows in the shared dev DB (workerDb bypasses the tx sandbox) + zoom token settings snapshot/restore; DB-heavy, not a smoke-gate candidate.",
  "tier": "small"
}
test-registration */
/**
 * Task #3689 — Zoom transcript backfill: terminal `unavailable` transition.
 *
 * A Zoom record whose backfill window (72h) lapsed with the recording final
 * but no TRANSCRIPT file used to stay `transcriptStatus='pending'` forever:
 * the enumeration's `createdAt >= cutoff` filter silently dropped aged rows,
 * so no sweep ever reconsidered them and the modal showed an ambiguous "No
 * transcript" (e.g. the Jul 2026 MP4+M4A+TIMELINE-only meetings in prod).
 *
 * This suite drives the REAL enumeration + per-record processor against the
 * dev DB with a stubbed Zoom API and asserts:
 *
 *   1. Enumeration now includes aged pending AND NULL-status rows (they used
 *      to fall outside the cutoff) and never includes ready/failed rows.
 *   2. Past-window + live-API-confirmed no TRANSCRIPT file → terminal
 *      'unavailable' with reason `no_transcript_after_window`, the de-duped
 *      observed file types, windowHours, and timestamp stored at
 *      rawPayloadJson.zoomTranscriptUnavailable (rest of payload preserved).
 *   3. Past-window + recording gone from Zoom (404) → terminal 'unavailable'
 *      with reason `recording_not_found` (no fileTypes).
 *   4. In-window rows keep pre-existing behavior: "skipped", still pending,
 *      still enumerated by the next sweep.
 *   5. Terminal rows drop out of subsequent enumerations, and re-processing
 *      one early-skips: no second Zoom API call, stored `at` unchanged.
 *   6. ready/failed rows are untouched and never even reach the API.
 *
 * Seeds tagged rows in the shared dev DB (workerDb bypasses the tx sandbox)
 * and deletes them in `finally`; zoom token settings are snapshotted and
 * restored.
 *
 * Task #3701: the stubbed recording set includes an M4A, which now routes
 * past-window records into the Rev AI generation fallback instead of the
 * terminal transition. This suite pins the `zoom_revai_transcription` kill
 * switch ON (snapshot/restored) — it is the regression proof that
 * kill-switch-ON sweep behavior stays byte-identical to Task #3689, which is
 * exactly what keeps parked rows revivable. The fallback's own behavior is
 * covered by tests/zoom-revai-fallback.test.ts.
 */
import assert from "node:assert/strict";

process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "task3689_client_id";
process.env.ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || "task3689_client_secret";
process.env.ZOOM_REDIRECT_URI = process.env.ZOOM_REDIRECT_URI || "https://example.com/api/zoom/callback";

const TAG = `t3689_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const ZOOM_API_BASE = "https://api.zoom.us/v2";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

const U_AGED_NOTX = `${TAG}_uuid_aged_no_tx`;
const U_AGED_GONE = `${TAG}_uuid_aged_gone`;
const U_FRESH = `${TAG}_uuid_fresh`;
const U_READY = `${TAG}_uuid_ready`;
const U_FAILED = `${TAG}_uuid_failed`;

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

/** Zoom recordings-API calls per meeting uuid — proves skip paths never re-fetch. */
const apiCalls = new Map<string, number>();

global.fetch = (async (input: any, init?: any) => {
  if (isUpstashRedisUrl(input)) return makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url === ZOOM_TOKEN_URL || url.includes("zoom.us/oauth/token")) {
    throw new Error(`Unexpected token refresh during test: ${url}`);
  }
  if (url.startsWith(ZOOM_API_BASE) || url.includes("api.zoom.us/")) {
    const m = url.match(/\/meetings\/([^/]+)\/recordings/);
    const uuid = m ? decodeURIComponent(m[1]) : "";
    apiCalls.set(uuid, (apiCalls.get(uuid) ?? 0) + 1);
    if (uuid === U_AGED_GONE) {
      // Zoom's "recording trashed/deleted" shape (404, error code 3301).
      return jsonResponse({ code: 3301, message: "This recording does not exist." }, 404);
    }
    // Final recording set with NO TRANSCRIPT file — the prod "3-file" shape,
    // plus a duplicate M4A and a typeless entry to prove de-dupe/filtering.
    return jsonResponse({
      uuid,
      recording_files: [
        { file_type: "MP4", download_url: "https://api.zoom.us/rec/mp4" },
        { file_type: "M4A", download_url: "https://api.zoom.us/rec/m4a" },
        { file_type: "TIMELINE", download_url: "https://api.zoom.us/rec/timeline" },
        { file_type: "M4A", download_url: "https://api.zoom.us/rec/m4a-dup" },
        { download_url: "https://api.zoom.us/rec/typeless" },
      ],
    });
  }
  return originalFetch(input as any, init);
}) as any;

const { workerDb } = await import("../server/db");
const { rawCommunicationRecords } = await import("../shared/models/communications");
const { storage } = await import("../server/storage");
const { eq, inArray } = await import("drizzle-orm");
const {
  enqueueTranscriptBackfillBatch,
  processTranscriptBackfillRecord,
  clearZoomPermanentFailure,
  clearZoomValidationBreaker,
  __clearPersistedZoomAuthGateForTest,
  __disableZoomAuthSelfHealForTest,
} = await import("../server/services/zoomIntegration");
const { __resetIntegrationStatusCacheForTest } = await import(
  "../server/services/integrationStatusCache"
);
const { setKillSwitch } = await import("../server/services/killSwitches");

// Task #3701: pin the Rev AI fallback OFF so this suite keeps exercising the
// #3689 terminal transition for audio-bearing records. Snapshot the persisted
// override row so the suite restores whatever state it found.
const REVAI_KILL_SWITCH_KEY = "kill_switch_zoom_revai_transcription";
const revAiKillSwitchSnap =
  (await storage.getSystemSetting(REVAI_KILL_SWITCH_KEY))?.value ?? null;

const SETTINGS = {
  ACCESS: "zoom_access_token",
  REFRESH: "zoom_refresh_token",
  EXPIRES: "zoom_token_expires_at",
} as const;

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

const HOURS = 60 * 60 * 1000;
const aged = new Date(Date.now() - 80 * HOURS); // well past the 72h window
const fresh = new Date(Date.now() - 1 * HOURS); // comfortably inside it

const ID_AGED_NOTX = `${TAG}_aged_notx`;
const ID_AGED_GONE = `${TAG}_aged_gone`;
const ID_FRESH = `${TAG}_fresh`;
const ID_READY = `${TAG}_ready`;
const ID_FAILED = `${TAG}_failed`;
const ALL_IDS = [ID_AGED_NOTX, ID_AGED_GONE, ID_FRESH, ID_READY, ID_FAILED];

const settingsSnap = await snapshotZoomSettings();

try {
  // Valid, far-future token so no refresh/lease machinery engages.
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
  await setKillSwitch("zoom_revai_transcription", true, "test");

  const seed = [
    { id: ID_AGED_NOTX, uuid: U_AGED_NOTX, status: "pending" as string | null, createdAt: aged, contentText: null as string | null },
    // NULL status proves legacy rows are enumerated + transitioned too.
    { id: ID_AGED_GONE, uuid: U_AGED_GONE, status: null, createdAt: aged, contentText: null },
    { id: ID_FRESH, uuid: U_FRESH, status: "pending", createdAt: fresh, contentText: null },
    { id: ID_READY, uuid: U_READY, status: "ready", createdAt: aged, contentText: "existing transcript text" },
    { id: ID_FAILED, uuid: U_FAILED, status: "failed", createdAt: aged, contentText: null },
  ];
  for (const r of seed) {
    await workerDb.insert(rawCommunicationRecords).values({
      id: r.id,
      sourceType: "zoom",
      title: `Task3689 seed ${r.id}`,
      timestamp: r.createdAt,
      transcriptStatus: r.status,
      contentText: r.contentText,
      createdAt: r.createdAt,
      rawPayloadJson: { meetingUuid: r.uuid, hasTranscript: false, recordingCount: 3 },
    });
  }

  // ---- 1. Enumeration includes aged pending/NULL rows, excludes terminal ones ----
  console.log("Scenario 1: sweep enumeration");
  {
    const batch = new Set(await enqueueTranscriptBackfillBatch());
    check("aged pending row enumerated (old cutoff would have dropped it)", batch.has(ID_AGED_NOTX));
    check("aged NULL-status row enumerated", batch.has(ID_AGED_GONE));
    check("fresh in-window row enumerated", batch.has(ID_FRESH));
    check("ready row NOT enumerated", !batch.has(ID_READY));
    check("failed row NOT enumerated", !batch.has(ID_FAILED));
  }

  // ---- 2. Past window + no TRANSCRIPT file → terminal unavailable ----
  console.log("Scenario 2: past-window no-transcript → unavailable");
  {
    const result = await processTranscriptBackfillRecord(ID_AGED_NOTX);
    check("processor returns 'unavailable'", result === "unavailable", result);
    const row = await getRow(ID_AGED_NOTX);
    check("transcriptStatus is 'unavailable'", row?.transcriptStatus === "unavailable", row?.transcriptStatus);
    const info = (row?.rawPayloadJson as any)?.zoomTranscriptUnavailable;
    check("reason is no_transcript_after_window", info?.reason === "no_transcript_after_window", info);
    check("windowHours stored as 72", info?.windowHours === 72, info?.windowHours);
    check(
      "observed file types stored de-duped in delivery order",
      JSON.stringify(info?.fileTypes) === JSON.stringify(["MP4", "M4A", "TIMELINE"]),
      info?.fileTypes,
    );
    check("transition timestamp is a valid ISO date", !Number.isNaN(Date.parse(info?.at ?? "")), info?.at);
    const payload = row?.rawPayloadJson as any;
    check("rest of rawPayloadJson preserved (meetingUuid)", payload?.meetingUuid === U_AGED_NOTX, payload?.meetingUuid);
    check("hasTranscript flag untouched (still false)", payload?.hasTranscript === false, payload?.hasTranscript);
  }

  // ---- 3. Past window + recording gone from Zoom → unavailable/recording_not_found ----
  console.log("Scenario 3: past-window 404 → recording_not_found");
  {
    const result = await processTranscriptBackfillRecord(ID_AGED_GONE);
    check("processor returns 'unavailable' for a 404'd recording", result === "unavailable", result);
    const row = await getRow(ID_AGED_GONE);
    check("404 row transcriptStatus is 'unavailable'", row?.transcriptStatus === "unavailable", row?.transcriptStatus);
    const info = (row?.rawPayloadJson as any)?.zoomTranscriptUnavailable;
    check("reason is recording_not_found", info?.reason === "recording_not_found", info);
    check("no fileTypes stored for a gone recording", info?.fileTypes === undefined, info?.fileTypes);
  }

  // ---- 4. In-window row keeps pre-existing behavior ----
  console.log("Scenario 4: in-window row stays pending");
  {
    const result = await processTranscriptBackfillRecord(ID_FRESH);
    check("in-window no-transcript → 'skipped'", result === "skipped", result);
    const row = await getRow(ID_FRESH);
    check("in-window row still 'pending'", row?.transcriptStatus === "pending", row?.transcriptStatus);
    check(
      "in-window row has NO terminal blob",
      (row?.rawPayloadJson as any)?.zoomTranscriptUnavailable === undefined,
    );
    check("in-window row DID get a live check", (apiCalls.get(U_FRESH) ?? 0) === 1, apiCalls.get(U_FRESH));
  }

  // ---- 5. ready/failed rows untouched, no API traffic ----
  console.log("Scenario 5: ready/failed rows untouched");
  {
    check("ready row → 'skipped'", (await processTranscriptBackfillRecord(ID_READY)) === "skipped");
    check("failed row → 'skipped'", (await processTranscriptBackfillRecord(ID_FAILED)) === "skipped");
    const ready = await getRow(ID_READY);
    const failed = await getRow(ID_FAILED);
    check("ready row status unchanged", ready?.transcriptStatus === "ready", ready?.transcriptStatus);
    check("ready row content unchanged", ready?.contentText === "existing transcript text");
    check("failed row status unchanged", failed?.transcriptStatus === "failed", failed?.transcriptStatus);
    check("ready row never hit the Zoom API", (apiCalls.get(U_READY) ?? 0) === 0, apiCalls.get(U_READY));
    check("failed row never hit the Zoom API", (apiCalls.get(U_FAILED) ?? 0) === 0, apiCalls.get(U_FAILED));
  }

  // ---- 6. Terminal rows excluded from the next sweep; transition idempotent ----
  console.log("Scenario 6: exclusion + idempotency");
  {
    const batch = new Set(await enqueueTranscriptBackfillBatch());
    check("unavailable (no-transcript) row excluded from next batch", !batch.has(ID_AGED_NOTX));
    check("unavailable (404) row excluded from next batch", !batch.has(ID_AGED_GONE));
    check("fresh pending row still enumerated next sweep", batch.has(ID_FRESH));

    const before = ((await getRow(ID_AGED_NOTX))?.rawPayloadJson as any)?.zoomTranscriptUnavailable?.at;
    const callsBefore = apiCalls.get(U_AGED_NOTX) ?? 0;
    check("terminal transition took exactly one API call", callsBefore === 1, callsBefore);
    await new Promise((r) => setTimeout(r, 10));
    const rerun = await processTranscriptBackfillRecord(ID_AGED_NOTX);
    check("re-processing a terminal row early-skips", rerun === "skipped", rerun);
    check("no additional API call on re-process", (apiCalls.get(U_AGED_NOTX) ?? 0) === callsBefore, apiCalls.get(U_AGED_NOTX));
    const after = ((await getRow(ID_AGED_NOTX))?.rawPayloadJson as any)?.zoomTranscriptUnavailable?.at;
    check("stored transition timestamp not re-stamped", after === before, { before, after });
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
    await restoreZoomSettings(settingsSnap);
  } catch (e) {
    console.error("cleanup: failed to restore zoom settings", e);
  }
  try {
    // Restore the kill-switch override row to exactly what we found: absent
    // rows are deleted (not written as "false", which would count as an
    // explicit operator override in the dashboard snapshot).
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

console.log(`\n✅ zoom-transcript-unavailable-sweep: all ${passed} assertions passed`);
