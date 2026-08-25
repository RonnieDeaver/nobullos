/* test-registration
{
  "name": "Zoom Match Assistant sweep — window math, discovery idempotency, phase walk (Task #4057)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy isolated-schema walk of the year-back sweep state machine (discovery windows, transcript batch, analysis enqueue). The route-level smoke coverage for this feature lives in zoom-match-assistant-routes.test.ts; this file pins the internals and runs in the full suite and nightly regression sweep.",
  "tier": "small"
}
test-registration */
/**
 * Task #4057 — Zoom Transcript Match Assistant: sweep engine.
 *
 * What this locks in:
 *
 *  A. computeSweepWindows: covers exactly 365 days in contiguous,
 *     non-overlapping, ≤30-day windows, newest first.
 *  B. Discovery phase: per-window listing → reconciliation-identical durable
 *     events + apply-job enqueues; a second sweep over the same window
 *     dedupes to ZERO new events/jobs (idempotent re-runs).
 *  C. Transcript phase: enumerates only zoom records in-window that still
 *     lack a transcript, calls the existing backfill with pastWindowOverride
 *     for old meetings, and maps outcomes onto counters.
 *  D. Analysis phase: enqueues analyze jobs only for transcript-bearing
 *     unmatched calls only (no client assigned), skipping already-analyzed
 *     and attempt-exhausted rows; then completes the sweep.
 *  E. Failure semantics: kill switch fails the sweep loudly; a
 *     ZoomPermanentError from the listing fails it with a reconnect hint;
 *     advance on a missing/finished sweep no-ops.
 *  F. Real listing helper (stubbed HTTP via its injectable deps): a
 *     mid-listing ZoomPermanentError PROPAGATES out of
 *     listRecordingsWindowPaginated instead of being swallowed as a
 *     per-user skip; transient errors skip only that user; pagination
 *     follows next_page_token.
 *  G. Durability: a THROWN transcript backfill holds the keyset cursor
 *     (bounded attempts, then an explicit surfaced failure — never a silent
 *     skip); the per-slice step CAS makes raced/stale advances lose without
 *     double-counting or forking the continuation chain; a crash between
 *     the slice commit and the continuation enqueue heals on job retry; a
 *     final-attempt handler failure marks the sweep failed explicitly; the
 *     status poll self-heals a silent chain with bounded resumes.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const {
  computeSweepWindows,
  advanceZoomMatchSweep,
  handleZoomMatchSweep,
  getZoomMatchSweepStatus,
  ZOOM_MATCH_GUESS_MAX_ATTEMPTS,
  TRANSCRIPT_RECORD_MAX_ATTEMPTS,
  SWEEP_MAX_AUTO_RESUMES,
} = await import("../server/services/zoomTranscriptMatchAssistant");
type SweepDeps = import("../server/services/zoomTranscriptMatchAssistant").ZoomMatchSweepDeps;
const { listRecordingsWindowPaginated, ZoomPermanentError } = await import(
  "../server/services/zoomIntegration"
);
const { runInIsolatedSchema } = await import("./db-sandbox");

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── A. Pure window math ────────────────────────────────────────────────────

function testWindows(): void {
  console.log("A. computeSweepWindows");
  const now = new Date("2026-08-07T15:30:00.000Z");
  const windows = computeSweepWindows(now);

  assert(windows.length >= 13 && windows.length <= 14, `~13 windows for 365 days (got ${windows.length})`);
  assert(windows[0].to === "2026-08-07", `newest window ends today (got ${windows[0].to})`);
  assert(
    windows[windows.length - 1].from === "2025-08-07",
    `oldest window starts 365 days back (got ${windows[windows.length - 1].from})`,
  );

  let contiguous = true;
  let maxSpan = 0;
  for (let i = 0; i < windows.length; i++) {
    const from = new Date(`${windows[i].from}T00:00:00.000Z`).getTime();
    const to = new Date(`${windows[i].to}T00:00:00.000Z`).getTime();
    const spanDays = Math.round((to - from) / DAY_MS) + 1;
    maxSpan = Math.max(maxSpan, spanDays);
    if (to < from) contiguous = false;
    if (i + 1 < windows.length) {
      const nextTo = new Date(`${windows[i + 1].to}T00:00:00.000Z`).getTime();
      // Next (older) window must end exactly the day before this one starts.
      if (nextTo !== from - DAY_MS) contiguous = false;
    }
  }
  assert(maxSpan <= 30, `every window spans ≤30 days (max ${maxSpan})`);
  assert(contiguous, "windows are contiguous and non-overlapping (next.to == prev.from - 1d)");
}

// ── F. Real listing helper: per-user error semantics ──────────────────────
//
// Section E proves the SWEEP fails when its injected listing throws; this
// section proves the real listRecordingsWindowPaginated PROPAGATES a
// mid-listing ZoomPermanentError instead of swallowing it as a per-user
// skip — a swallowed permanent error would mark the window "done" with
// meetings silently missing. Uses the function's injectable test deps; no
// network, no DB.

async function testListingErrorSemantics(): Promise<void> {
  console.log("F. listRecordingsWindowPaginated per-user error semantics");
  const users = [
    { id: "u-broken", email: "broken@example.invalid" },
    { id: "u-ok", email: "ok@example.invalid", name: "Okay Host" },
  ];

  // Permanent: the exact error instance must surface to the caller.
  const permanent = new ZoomPermanentError("auth", 401, "token revoked mid-window");
  let caught: unknown = null;
  let returned: any[] | null = null;
  try {
    returned = await listRecordingsWindowPaginated("2026-01-01", "2026-01-30", {
      listUsers: async () => users,
      apiRequest: async (path: string) => {
        if (path.startsWith("/users/u-broken/")) throw permanent;
        return { meetings: [{ uuid: "unreached" }] };
      },
    });
  } catch (err) {
    caught = err;
  }
  assert(returned === null, "permanent mid-listing failure yields no honest-looking result");
  assert(caught === permanent, "the ZoomPermanentError instance propagates out of the listing");

  // Transient: skip only the broken user; walk the healthy user's pages.
  const paths: string[] = [];
  const collected = await listRecordingsWindowPaginated("2026-01-01", "2026-01-30", {
    listUsers: async () => users,
    apiRequest: async (path: string) => {
      paths.push(path);
      if (path.startsWith("/users/u-broken/")) throw new Error("socket hang up");
      if (!path.includes("next_page_token=")) {
        return { meetings: [{ uuid: "page1" }], next_page_token: "tok 2" };
      }
      return { meetings: [{ uuid: "page2", host_email: "explicit@example.invalid" }] };
    },
  });
  assert(collected.length === 2, `transient failure skips only that user (got ${collected.length} meetings)`);
  assert(
    collected[0]?.uuid === "page1" && collected[1]?.uuid === "page2",
    "healthy user's pages are all collected via next_page_token",
  );
  assert(
    paths.some((p) => p.startsWith("/users/u-ok/") && p.includes("next_page_token=tok%202")),
    "follow-up page request carries the URL-encoded next_page_token",
  );
  assert(collected[0]?.host_email === "ok@example.invalid", "missing host_email backfilled from the user listing");
  assert(collected[1]?.host_email === "explicit@example.invalid", "explicit host_email preserved");
}

// ── DB-backed phases ───────────────────────────────────────────────────────

const TAG = `zms-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

interface FakeWorld {
  listByWindow: Map<string, any[]>;
  ingestSeen: Set<string>;
  ingestCalls: Array<{ dedupeKey: string; sourceEventType: string }>;
  enqueues: Array<{ queueName: string; dedupeKey?: string; payload?: any; retryAt?: Date }>;
  transcriptCalls: Array<{ recordId: string; pastWindowOverride?: boolean }>;
  transcriptOutcomes: Map<string, "backfilled" | "skipped" | "failed" | "unavailable" | "revai_enqueued">;
  killSwitch: boolean;
  listError: Error | null;
  /** Per-record remaining THROW count for processTranscriptRecord. */
  transcriptThrows: Map<string, number>;
  /** Throw once on the next enqueue for this queue (simulated crash). */
  enqueueFailOnce: { queueName: string; error: Error } | null;
  /** One-shot gate awaited inside listRecordings (race interleaving). */
  listGate: (() => Promise<void>) | null;
  /** Stubbed countLiveSweepJobs result (chain-liveness probe). */
  liveSweepJobs: number;
  /** Every listRecordings invocation (external-work tracking). */
  listCalls: string[];
}

function makeDeps(world: FakeWorld): SweepDeps {
  return {
    listRecordings: async (from, to) => {
      world.listCalls.push(`${from}..${to}`);
      if (world.listGate) {
        const gate = world.listGate;
        world.listGate = null;
        await gate();
      }
      if (world.listError) throw world.listError;
      return world.listByWindow.get(`${from}..${to}`) ?? [];
    },
    ingestEvent: async (input) => {
      world.ingestCalls.push({ dedupeKey: input.dedupeKey, sourceEventType: input.sourceEventType });
      const deduplicated = world.ingestSeen.has(input.dedupeKey);
      world.ingestSeen.add(input.dedupeKey);
      return { id: `evt-${input.dedupeKey}`, deduplicated };
    },
    enqueue: async (input) => {
      if (world.enqueueFailOnce && input.queueName === world.enqueueFailOnce.queueName) {
        const { error } = world.enqueueFailOnce;
        world.enqueueFailOnce = null;
        throw error;
      }
      world.enqueues.push({
        queueName: input.queueName,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        retryAt: input.retryAt,
      });
    },
    processTranscriptRecord: async (recordId, opts) => {
      world.transcriptCalls.push({ recordId, pastWindowOverride: opts?.pastWindowOverride });
      const remaining = world.transcriptThrows.get(recordId) ?? 0;
      if (remaining > 0) {
        world.transcriptThrows.set(recordId, remaining - 1);
        throw new Error(`backfill boom for ${recordId}`);
      }
      return world.transcriptOutcomes.get(recordId) ?? "skipped";
    },
    isKillSwitchEnabled: () => world.killSwitch,
    now: () => new Date(),
    countLiveSweepJobs: async () => world.liveSweepJobs,
  };
}

function freshWorld(): FakeWorld {
  return {
    listByWindow: new Map(),
    ingestSeen: new Set(),
    ingestCalls: [],
    enqueues: [],
    transcriptCalls: [],
    transcriptOutcomes: new Map(),
    killSwitch: false,
    listError: null,
    transcriptThrows: new Map(),
    enqueueFailOnce: null,
    listGate: null,
    liveSweepJobs: 0,
    listCalls: [],
  };
}

async function insertSweep(
  db: any,
  windows: Array<{ from: string; to: string }>,
  overrides?: { status?: string; phase?: string },
): Promise<string> {
  const id = randomUUID();
  const windowStart = new Date(Date.now() - 365 * DAY_MS).toISOString();
  const windowsJson = JSON.stringify(windows.map((w) => ({ ...w, status: "pending" })));
  const counters = JSON.stringify({});
  await db.execute(sql`
    INSERT INTO zoom_match_sweeps
      (id, status, phase, window_start, window_end, windows_json, counters_json, phase_state_json)
    VALUES
      (${id}, ${overrides?.status ?? "running"}, ${overrides?.phase ?? "discovery"},
       ${windowStart}::timestamp, NOW(), ${windowsJson}::jsonb, ${counters}::jsonb, '{}'::jsonb)
  `);
  return id;
}

async function getSweep(db: any, id: string): Promise<any> {
  const res: any = await db.execute(sql`SELECT * FROM zoom_match_sweeps WHERE id = ${id}`);
  return (Array.isArray(res) ? res : res.rows)[0];
}

async function insertRecord(
  db: any,
  fields: {
    daysAgo: number;
    sourceType?: string;
    contentText?: string | null;
    transcriptStatus?: string | null;
    clientId?: string | null;
    matchMethod?: string | null;
    matchConfidence?: number | null;
  },
): Promise<string> {
  const id = randomUUID();
  const ts = new Date(Date.now() - fields.daysAgo * DAY_MS).toISOString();
  await db.execute(sql`
    INSERT INTO raw_communication_records
      (id, source_type, title, timestamp, content_text, transcript_status,
       client_id, match_method, match_confidence)
    VALUES
      (${id}, ${fields.sourceType ?? "zoom"}, ${`ZMS ${TAG} ${id.slice(0, 8)}`},
       ${ts}::timestamp, ${fields.contentText ?? null}, ${fields.transcriptStatus ?? null},
       ${fields.clientId ?? null}, ${fields.matchMethod ?? null}, ${fields.matchConfidence ?? null})
  `);
  return id;
}

async function main(): Promise<void> {
  testWindows();
  await testListingErrorSemantics();

  await runInIsolatedSchema(
    async ({ db }) => {
      // ── B. Discovery: events + enqueues, then idempotent re-run ─────────
      console.log("B. Discovery phase");
      const w1 = { from: "2026-07-09", to: "2026-08-07" };
      const w2 = { from: "2026-06-09", to: "2026-07-08" };
      const world = freshWorld();
      const uuidA = `uuidA-${TAG}`;
      const uuidB = `uuidB-${TAG}`;
      const uuidC = `uuidC-${TAG}`;
      world.listByWindow.set(`${w1.from}..${w1.to}`, [
        {
          uuid: uuidA,
          id: 111,
          topic: "Call A",
          recording_files: [
            { id: "recA", file_type: "MP4" },
            { id: "recA-t", file_type: "TRANSCRIPT" },
          ],
        },
        { uuid: uuidB, id: 222, topic: "Call B", recording_files: [{ id: "recB", file_type: "MP4" }] },
      ]);
      world.listByWindow.set(`${w2.from}..${w2.to}`, [
        { uuid: uuidC, id: 333, topic: "Call C", recording_files: [] },
      ]);
      const deps = makeDeps(world);

      const sweep1 = await insertSweep(db, [w1, w2]);
      const c1 = await advanceZoomMatchSweep(sweep1, deps);
      assert(c1 === "discovery:window:0", `first advance processes window 0 (got ${c1})`);

      let row = await getSweep(db, sweep1);
      assert(row.windows_json[0].status === "done", "window 0 marked done");
      assert(row.windows_json[0].meetingsFound === 2, "window 0 recorded meetingsFound=2");
      assert(row.windows_json[1].status === "pending", "window 1 still pending");
      assert(Number(row.counters_json.meetingsFound) === 2, "counters.meetingsFound=2");
      assert(Number(row.counters_json.meetingsIngestEnqueued) === 2, "counters.meetingsIngestEnqueued=2");

      const recEvents = world.ingestCalls.filter((c) => c.sourceEventType === "recording_completed");
      const trEvents = world.ingestCalls.filter((c) => c.sourceEventType === "transcript_completed");
      assert(recEvents.length === 2, "one recording_completed event per meeting");
      assert(
        trEvents.length === 1 && trEvents[0].dedupeKey === `zoom:transcript_completed:${uuidA}:recA`,
        "transcript_completed event only for the meeting with a TRANSCRIPT file, reconciliation-keyed",
      );
      assert(
        recEvents[0].dedupeKey === `zoom:recording_completed:${uuidA}:recA`,
        "recording dedupe key matches the reconciliation format (uuid + first file id)",
      );
      const applyJobs = world.enqueues.filter((e) => e.queueName === "zoom_meeting_apply");
      const transcriptJobs = world.enqueues.filter((e) => e.queueName === "zoom_transcript_apply");
      assert(applyJobs.length === 2, "zoom_meeting_apply enqueued per new event");
      assert(transcriptJobs.length === 1, "zoom_transcript_apply enqueued for the transcript event");
      assert(
        applyJobs.every((j) => j.dedupeKey?.startsWith("zoom_meeting_apply:evt-")),
        "apply jobs dedupe-keyed on the event id (reconciliation format)",
      );
      const cont1 = world.enqueues.find((e) => e.dedupeKey === `zoom_match_sweep:${sweep1}:s1:w1`);
      assert(!!cont1, "continuation job enqueued with the step-keyed dedupe key (s1)");

      const c2 = await advanceZoomMatchSweep(sweep1, deps);
      assert(c2 === "discovery:window:1", `second advance processes window 1 (got ${c2})`);
      const c3 = await advanceZoomMatchSweep(sweep1, deps);
      assert(c3 === "discovery:complete", `third advance flips to transcripts (got ${c3})`);
      row = await getSweep(db, sweep1);
      assert(row.phase === "transcripts", "phase advanced to transcripts");

      // Idempotent re-run: a second sweep over the same windows sees every
      // event as a duplicate and enqueues ZERO new apply jobs. (Direct
      // INSERT — the one-running-sweep guard lives in startZoomMatchSweep,
      // which the routes test covers; sweep1 stays running for phases C/D.)
      const sweep2 = await insertSweep(db, [w1, w2]);
      const enqueuesBefore = world.enqueues.length;
      await advanceZoomMatchSweep(sweep2, deps);
      await advanceZoomMatchSweep(sweep2, deps);
      const newApplyJobs = world.enqueues
        .slice(enqueuesBefore)
        .filter((e) => e.queueName === "zoom_meeting_apply" || e.queueName === "zoom_transcript_apply");
      const row2 = await getSweep(db, sweep2);
      assert(newApplyJobs.length === 0, "re-run over the same windows enqueues zero new apply jobs (all deduped)");
      assert(Number(row2.counters_json.meetingsFound) === 3, "re-run still counts meetings found");
      assert(
        Number(row2.counters_json.meetingsIngestEnqueued ?? 0) === 0,
        "re-run counts zero newly-ingested meetings",
      );
      await db.execute(sql`UPDATE zoom_match_sweeps SET status = 'failed' WHERE id = ${sweep2}`);

      // ── C. Transcript phase ──────────────────────────────────────────────
      console.log("C. Transcript phase");
      // Eligible: zoom, in-window, no transcript content, pending/NULL status.
      const recMissing = await insertRecord(db, { daysAgo: 100, transcriptStatus: "pending", contentText: "" });
      // 1 day old — inside the 72h ZOOM_TRANSCRIPT_BACKFILL_HOURS window.
      const recMissing2 = await insertRecord(db, { daysAgo: 1, transcriptStatus: null, contentText: null });
      // Excluded: already has content / terminal-unavailable / not zoom.
      const recHasContent = await insertRecord(db, { daysAgo: 50, contentText: "hello transcript" });
      await insertRecord(db, { daysAgo: 60, transcriptStatus: "unavailable", contentText: "" });
      await insertRecord(db, { daysAgo: 30, sourceType: "front_email", contentText: "" });
      // Excluded: call already assigned to a client — the assistant sweeps
      // ONLY unmatched calls, so no transcript backfill is spent on it.
      const clientRes: any = await db.execute(sql`
        INSERT INTO clients (firm_name) VALUES (${`ZMS Client ${TAG}`}) RETURNING id
      `);
      const clientId = (Array.isArray(clientRes) ? clientRes : clientRes.rows)[0].id;
      await insertRecord(db, {
        daysAgo: 45, transcriptStatus: "pending", contentText: "", clientId,
      });

      world.transcriptOutcomes.set(recMissing, "backfilled");
      world.transcriptOutcomes.set(recMissing2, "revai_enqueued");

      const tCursor1 = await advanceZoomMatchSweep(sweep1, deps);
      assert(tCursor1 === "transcripts:batch:2", `transcript batch processed 2 records (got ${tCursor1})`);
      const calledIds = world.transcriptCalls.map((c) => c.recordId).sort();
      assert(
        calledIds.length === 2 && calledIds.includes(recMissing) && calledIds.includes(recMissing2),
        "backfill called exactly for the two transcript-missing zoom records",
      );
      const oldCall = world.transcriptCalls.find((c) => c.recordId === recMissing);
      const newCall = world.transcriptCalls.find((c) => c.recordId === recMissing2);
      assert(oldCall?.pastWindowOverride === true, "100-day-old meeting gets pastWindowOverride=true");
      assert(newCall?.pastWindowOverride === false, "1-day-old meeting stays within the normal 72h backfill window");

      row = await getSweep(db, sweep1);
      assert(Number(row.counters_json.transcriptsChecked) === 2, "transcriptsChecked=2");
      assert(Number(row.counters_json.transcriptsDownloaded) === 1, "backfilled → transcriptsDownloaded");
      assert(Number(row.counters_json.transcriptsGenerating) === 1, "revai_enqueued → transcriptsGenerating");

      const tCursor2 = await advanceZoomMatchSweep(sweep1, deps);
      assert(tCursor2 === "transcripts:complete", `empty batch flips to analysis (got ${tCursor2})`);
      row = await getSweep(db, sweep1);
      assert(row.phase === "analysis", "phase advanced to analysis");

      // ── D. Analysis phase ────────────────────────────────────────────────
      console.log("D. Analysis phase");
      // Simulate the backfill having landed a transcript on recMissing.
      await db.execute(sql`
        UPDATE raw_communication_records
        SET content_text = 'now has words', transcript_status = 'ready'
        WHERE id = ${recMissing}
      `);
      // Excluded: ANY call with a client already assigned (manual or auto at
      // any confidence — the assistant only analyzes unmatched calls), plus
      // analyzed and exhausted-failed rows. Included: unmatched calls — the
      // retryable-failed row and the two transcript-bearing ones.
      const recManual = await insertRecord(db, {
        daysAgo: 10, contentText: "words", clientId, matchMethod: "manual", matchConfidence: 1.0,
      });
      const recHighAuto = await insertRecord(db, {
        daysAgo: 11, contentText: "words", clientId, matchMethod: "domain", matchConfidence: 0.9,
      });
      const recLowAuto = await insertRecord(db, {
        daysAgo: 12, contentText: "words", clientId, matchMethod: "keyword", matchConfidence: 0.3,
      });
      const recAnalyzed = await insertRecord(db, { daysAgo: 13, contentText: "words" });
      await db.execute(sql`
        INSERT INTO zoom_transcript_match_analyses (record_id, status, attempts, analyzed_at)
        VALUES (${recAnalyzed}, 'analyzed', 1, NOW())
      `);
      const recExhausted = await insertRecord(db, { daysAgo: 14, contentText: "words" });
      await db.execute(sql`
        INSERT INTO zoom_transcript_match_analyses (record_id, status, attempts, error)
        VALUES (${recExhausted}, 'failed', ${ZOOM_MATCH_GUESS_MAX_ATTEMPTS}, 'boom')
      `);
      const recRetryable = await insertRecord(db, { daysAgo: 15, contentText: "words" });
      await db.execute(sql`
        INSERT INTO zoom_transcript_match_analyses (record_id, status, attempts, error)
        VALUES (${recRetryable}, 'failed', 1, 'transient')
      `);

      const preAnalysis = world.enqueues.length;
      const aCursor = await advanceZoomMatchSweep(sweep1, deps);
      assert(aCursor === "complete", `final analysis batch completes the sweep (got ${aCursor})`);

      const analyzeJobs = world.enqueues
        .slice(preAnalysis)
        .filter((e) => e.queueName === "zoom_match_analyze");
      const enqueuedIds = new Set(analyzeJobs.map((j) => j.payload?.recordId));
      const expected = [recMissing, recHasContent, recRetryable];
      assert(
        expected.every((id) => enqueuedIds.has(id)),
        "analyze jobs enqueued only for unmatched transcript-bearing calls (incl. retryable failed)",
      );
      assert(!enqueuedIds.has(recManual), "manual match skipped");
      assert(!enqueuedIds.has(recHighAuto), "high-confidence auto match skipped");
      assert(
        !enqueuedIds.has(recLowAuto),
        "low-confidence auto match ALSO skipped — any client assignment excludes the call",
      );
      assert(!enqueuedIds.has(recAnalyzed), "already-analyzed record skipped");
      assert(!enqueuedIds.has(recExhausted), "attempt-exhausted failed record skipped");
      assert(
        analyzeJobs.every((j) => j.dedupeKey === `zoom_match_analyze:${j.payload?.recordId}`),
        "analyze jobs use the per-record dedupe key (re-runs collapse)",
      );

      row = await getSweep(db, sweep1);
      assert(row.status === "completed" && row.phase === "done", "sweep row completed/done");
      assert(row.finished_at !== null, "finished_at stamped");
      assert(
        Number(row.counters_json.analysesEnqueued) === analyzeJobs.length,
        "counters.analysesEnqueued matches enqueued jobs",
      );

      // ── E. Failure semantics ─────────────────────────────────────────────
      console.log("E. Failure semantics");
      const missing = await advanceZoomMatchSweep(randomUUID(), deps);
      assert(missing === "skipped:sweep_missing", "advance on unknown sweep no-ops");
      const done = await advanceZoomMatchSweep(sweep1, deps);
      assert(done.startsWith("skipped:not_running"), "advance on finished sweep no-ops");

      const sweep3 = await insertSweep(db, [w1]);
      world.killSwitch = true;
      const killed = await advanceZoomMatchSweep(sweep3, deps);
      assert(killed === "failed:kill_switch", "kill switch fails the sweep");
      const row3 = await getSweep(db, sweep3);
      assert(
        row3.status === "failed" && String(row3.last_error).includes("non_critical_sweeps"),
        "kill-switch failure is loud and names the switch",
      );
      world.killSwitch = false;

      const sweep4 = await insertSweep(db, [w1]);
      const permErr = new Error("zoom auth gate engaged");
      permErr.name = "ZoomPermanentError";
      world.listError = permErr;
      const permanent = await advanceZoomMatchSweep(sweep4, deps);
      assert(permanent === "failed:zoom_permanent", "ZoomPermanentError fails the sweep");
      const row4 = await getSweep(db, sweep4);
      assert(
        row4.status === "failed" && String(row4.last_error).includes("reconnect Zoom"),
        "permanent failure lastError tells the operator to reconnect Zoom",
      );
      world.listError = null;

      // ── G. Durability: thrown records, CAS races, chain recovery ────────
      console.log("G. Durability semantics");

      // G1. A transcript backfill that THROWS must not be silently skipped:
      // the cursor holds, retries are bounded, then the record becomes an
      // explicit surfaced failure and the sweep still completes honestly.
      await db.execute(sql`
        UPDATE raw_communication_records SET content_text = 'x' WHERE id = ${recMissing2}
      `);
      const g1 = await insertRecord(db, { daysAgo: 20, transcriptStatus: "pending", contentText: "" });
      const gThrow = await insertRecord(db, { daysAgo: 19, transcriptStatus: "pending", contentText: "" });
      const g3 = await insertRecord(db, { daysAgo: 18, transcriptStatus: "pending", contentText: "" });
      world.transcriptOutcomes.set(g1, "backfilled");
      world.transcriptOutcomes.set(g3, "backfilled");
      world.transcriptThrows.set(gThrow, Number.MAX_SAFE_INTEGER);

      const sweepG = await insertSweep(db, [], { phase: "transcripts" });
      const gPass1 = await advanceZoomMatchSweep(sweepG, deps);
      assert(
        gPass1 === `transcripts:retrying:${gThrow}:1`,
        `pass 1 holds at the thrown record with attempt 1 (got ${gPass1})`,
      );
      let gRow = await getSweep(db, sweepG);
      assert(gRow.phase === "transcripts", "phase stays transcripts while holding");
      assert(
        gRow.phase_state_json?.transcriptRetry?.id === gThrow &&
          gRow.phase_state_json?.transcriptRetry?.attempts === 1,
        "retry marker parked on the throwing record",
      );
      assert(
        gRow.phase_state_json?.transcriptCursor?.id === g1,
        "cursor held at the last TERMINAL record — never advanced past a thrown one",
      );
      assert(Number(gRow.counters_json.transcriptsChecked) === 1, "only the terminal record counted as checked");
      const holdCont = world.enqueues[world.enqueues.length - 1];
      assert(
        holdCont.dedupeKey === `zoom_match_sweep:${sweepG}:s1:tr1` && holdCont.retryAt instanceof Date,
        "hold continuation is step-keyed and delayed",
      );

      const gPass2 = await advanceZoomMatchSweep(sweepG, deps);
      assert(
        gPass2 === `transcripts:retrying:${gThrow}:2`,
        `pass 2 re-attempts the same record (got ${gPass2})`,
      );
      assert(
        world.transcriptCalls.filter((c) => c.recordId === g1).length === 1,
        "terminal record processed exactly once across the retries",
      );

      const gPass3 = await advanceZoomMatchSweep(sweepG, deps);
      assert(
        gPass3 === "transcripts:batch:2",
        `pass 3 exhausts attempts, surfaces the failure, and continues past it (got ${gPass3})`,
      );
      assert(
        world.transcriptCalls.filter((c) => c.recordId === gThrow).length === TRANSCRIPT_RECORD_MAX_ATTEMPTS,
        "throwing record attempted exactly TRANSCRIPT_RECORD_MAX_ATTEMPTS times",
      );
      gRow = await getSweep(db, sweepG);
      assert(gRow.phase_state_json?.transcriptRetry == null, "retry marker cleared after give-up");
      const gFailures = gRow.phase_state_json?.transcriptFailures ?? [];
      assert(
        gFailures.length === 1 &&
          gFailures[0].recordId === gThrow &&
          String(gFailures[0].error).includes("backfill boom"),
        "explicit failure entry records the record id and error",
      );
      assert(
        gRow.phase_state_json?.transcriptCursor?.id === g3,
        "cursor passes the failed record only after the explicit give-up",
      );
      assert(Number(gRow.counters_json.transcriptsChecked) === 3, "all three records reached a terminal accounting");
      assert(Number(gRow.counters_json.transcriptsDownloaded) === 2, "records around the failure still processed");
      assert(Number(gRow.counters_json.transcriptsFailed) === 1, "exhausted record counted as failed");

      const gPass4 = await advanceZoomMatchSweep(sweepG, deps);
      assert(gPass4 === "transcripts:complete", `empty batch flips to analysis (got ${gPass4})`);
      const gPass5 = await advanceZoomMatchSweep(sweepG, deps);
      assert(gPass5 === "complete", `sweep completes despite the poisoned record (got ${gPass5})`);
      gRow = await getSweep(db, sweepG);
      assert(gRow.status === "completed", "sweep status completed");
      assert(
        String(gRow.last_error).includes("1 record(s) failed transcript processing"),
        "completion surfaces the failure count in lastError instead of looking clean",
      );

      // G2. A throw-once-then-succeed record converges with NO failure entry.
      world.transcriptThrows.delete(gThrow);
      world.transcriptOutcomes.set(gThrow, "skipped");
      const gFlaky = await insertRecord(db, { daysAgo: 17, transcriptStatus: "pending", contentText: "" });
      world.transcriptOutcomes.set(gFlaky, "backfilled");
      world.transcriptThrows.set(gFlaky, 1);
      const sweepG2 = await insertSweep(db, [], { phase: "transcripts" });
      const g2p1 = await advanceZoomMatchSweep(sweepG2, deps);
      assert(
        g2p1 === `transcripts:retrying:${gFlaky}:1`,
        `flaky record holds the cursor on its first throw (got ${g2p1})`,
      );
      const g2p2 = await advanceZoomMatchSweep(sweepG2, deps);
      assert(g2p2 === "transcripts:batch:1", `flaky record succeeds on the retry pass (got ${g2p2})`);
      const g2Row = await getSweep(db, sweepG2);
      assert(g2Row.phase_state_json?.transcriptRetry == null, "retry marker cleared on success");
      assert(
        (g2Row.phase_state_json?.transcriptFailures ?? []).length === 0,
        "no failure entry for a record that recovered",
      );
      await db.execute(sql`UPDATE zoom_match_sweeps SET status = 'failed' WHERE id = ${sweepG2}`);

      // G3. Step CAS: two racing advances for the SAME slice — exactly one
      // commits/counts/enqueues; the loser returns stale without forking.
      const wR = { from: "2026-01-01", to: "2026-01-30" };
      world.listByWindow.set(`${wR.from}..${wR.to}`, [
        {
          uuid: `uuidR-${TAG}`,
          id: 999,
          topic: "Race",
          recording_files: [{ id: "recR", file_type: "MP4" }],
        },
      ]);
      const sweepR = await insertSweep(db, [wR]);
      let releaseGate!: () => void;
      const gatePromise = new Promise<void>((r) => (releaseGate = r));
      let gateEntered!: () => void;
      const enteredPromise = new Promise<void>((r) => (gateEntered = r));
      world.listGate = () => {
        gateEntered();
        return gatePromise;
      };
      const slowAdvance = advanceZoomMatchSweep(sweepR, deps);
      await enteredPromise; // slow twin is parked mid-listing with step 0 loaded
      const fastResult = await advanceZoomMatchSweep(sweepR, deps);
      assert(fastResult === "discovery:window:0", `racing twin commits the slice (got ${fastResult})`);
      releaseGate();
      const slowResult = await slowAdvance;
      assert(
        slowResult === "skipped:stale_advance",
        `CAS loser returns stale_advance instead of double-committing (got ${slowResult})`,
      );
      const rRow = await getSweep(db, sweepR);
      assert(Number(rRow.counters_json.meetingsFound) === 1, "raced slice counted exactly once");
      assert(
        world.enqueues.filter((e) => e.dedupeKey === `zoom_match_sweep:${sweepR}:s1:w1`).length === 1,
        "exactly one continuation enqueued for the raced step",
      );
      await db.execute(sql`UPDATE zoom_match_sweeps SET status = 'failed' WHERE id = ${sweepR}`);

      // G4. Crash AFTER the slice commit but BEFORE the continuation
      // enqueue: the advance rethrows (queue retries the same job); the
      // retry fails the step-authorization match, finds a DEAD chain, and
      // enqueues a heal job authorized for the CURRENT step — no lost
      // chain, no double count, no blind re-execution by the stale job.
      const wX = { from: "2026-02-01", to: "2026-02-28" };
      const wY = { from: "2026-03-01", to: "2026-03-30" };
      world.listByWindow.set(`${wX.from}..${wX.to}`, [
        {
          uuid: `uuidX-${TAG}`,
          id: 555,
          topic: "Crash",
          recording_files: [{ id: "recX", file_type: "MP4" }],
        },
      ]);
      world.listByWindow.set(`${wY.from}..${wY.to}`, []);
      const sweepX = await insertSweep(db, [wX, wY]);
      world.enqueueFailOnce = {
        queueName: "zoom_match_sweep",
        error: new Error("simulated crash before continuation enqueue"),
      };
      let crashed: any = null;
      try {
        await advanceZoomMatchSweep(sweepX, deps, { jobStep: 0 });
      } catch (e: any) {
        crashed = e;
      }
      assert(
        !!crashed && String(crashed.message).includes("simulated crash"),
        "advance rethrows when the continuation enqueue fails (queue will retry)",
      );
      let xRow = await getSweep(db, sweepX);
      assert(xRow.windows_json?.[0]?.status === "done", "slice progress committed before the crash");
      assert(Number(xRow.phase_state_json?.step ?? 0) === 1, "step advanced with the committed slice");
      const listCallsAfterCrash = world.listCalls.length;
      const retryResult = await advanceZoomMatchSweep(sweepX, deps, { jobStep: 0 });
      assert(
        retryResult === "skipped:stale_job_healed",
        `retried stale job heals the dead chain instead of executing a slice (got ${retryResult})`,
      );
      assert(
        world.listCalls.length === listCallsAfterCrash,
        "stale retry performed no external listing work",
      );
      const healJob = world.enqueues[world.enqueues.length - 1];
      assert(
        healJob.dedupeKey === `zoom_match_sweep:${sweepX}:s1:heal` &&
          (healJob.payload as any)?.step === 1,
        "heal continuation authorized for the CURRENT committed step",
      );
      const healResult = await advanceZoomMatchSweep(sweepX, deps, { jobStep: 1 });
      assert(healResult === "discovery:window:1", `heal job executes the NEXT slice (got ${healResult})`);
      xRow = await getSweep(db, sweepX);
      assert(
        Number(xRow.counters_json.meetingsFound) === 1,
        "crashed window not double-counted across retry + heal",
      );
      assert(
        world.enqueues.filter((e) => e.dedupeKey === `zoom_match_sweep:${sweepX}:s2:w2`).length === 1,
        "heal chain enqueues the next step's continuation exactly once",
      );
      await db.execute(sql`UPDATE zoom_match_sweeps SET status = 'failed' WHERE id = ${sweepX}`);

      // G7. Replay of an OLD job (lease-expiry ghost) AFTER its successors
      // completed: completed queue rows no longer dedupe-conflict, so the
      // only protection is step authorization. With a live successor the
      // replay is a PURE no-op (no side effects, no counters, no
      // continuation — the chain cannot fork); with a dead chain it heals
      // without executing any slice work itself.
      const wP1 = { from: "2026-06-01", to: "2026-06-30" };
      const wP2 = { from: "2026-07-01", to: "2026-07-30" };
      world.listByWindow.set(`${wP1.from}..${wP1.to}`, [
        {
          uuid: `uuidP-${TAG}`,
          id: 777,
          topic: "Replay",
          recording_files: [{ id: "recP", file_type: "MP4" }],
        },
      ]);
      world.listByWindow.set(`${wP2.from}..${wP2.to}`, []);
      const sweepP = await insertSweep(db, [wP1, wP2]);
      const p1 = await advanceZoomMatchSweep(sweepP, deps, { jobStep: 0 });
      assert(p1 === "discovery:window:0", `step-0 job executes its slice (got ${p1})`);
      const p2 = await advanceZoomMatchSweep(sweepP, deps, { jobStep: 1 });
      assert(p2 === "discovery:window:1", `step-1 job executes the next slice (got ${p2})`);

      world.liveSweepJobs = 1; // the s2 continuation is live somewhere
      const enqBefore = world.enqueues.length;
      const listBefore = world.listCalls.length;
      const rowBefore = await getSweep(db, sweepP);
      const replay = await advanceZoomMatchSweep(sweepP, deps, { jobStep: 0 });
      assert(
        replay === "skipped:stale_job",
        `old-job replay with a live chain is a pure no-op (got ${replay})`,
      );
      const rowAfterReplay = await getSweep(db, sweepP);
      assert(world.enqueues.length === enqBefore, "replay enqueued NO new continuation");
      assert(world.listCalls.length === listBefore, "replay performed NO external work");
      assert(
        JSON.stringify(rowAfterReplay.counters_json) === JSON.stringify(rowBefore.counters_json) &&
          Number(rowAfterReplay.phase_state_json?.step) === Number(rowBefore.phase_state_json?.step),
        "replay changed no counters and no step",
      );

      world.liveSweepJobs = 0; // chain actually dead → replay may heal only
      const replay2 = await advanceZoomMatchSweep(sweepP, deps, { jobStep: 0 });
      assert(
        replay2 === "skipped:stale_job_healed",
        `dead-chain replay heals without executing a slice (got ${replay2})`,
      );
      assert(world.listCalls.length === listBefore, "heal itself performs no slice work");
      const pHeal = world.enqueues[world.enqueues.length - 1];
      assert(
        pHeal.dedupeKey === `zoom_match_sweep:${sweepP}:s2:heal` && (pHeal.payload as any)?.step === 2,
        "heal continuation authorized for the current committed step (2)",
      );
      await db.execute(sql`UPDATE zoom_match_sweeps SET status = 'failed' WHERE id = ${sweepP}`);

      // G5. Final-attempt handler failure marks the sweep failed explicitly
      // (instead of stranding it 'running' after the job dead-letters).
      const wZ = { from: "2026-04-01", to: "2026-04-30" };
      const sweepZ = await insertSweep(db, [wZ]);
      world.listError = new Error("transient zoom flake");
      let rethrown: any = null;
      try {
        await handleZoomMatchSweep(
          { payload: { sweepId: sweepZ }, attemptCount: 2, maxAttempts: 3 } as any,
          deps,
        );
      } catch (e: any) {
        rethrown = e;
      }
      assert(
        !!rethrown && String(rethrown.message).includes("transient zoom flake"),
        "handler rethrows so the queue records the failure",
      );
      const zRow = await getSweep(db, sweepZ);
      assert(zRow.status === "failed", "final attempt marks the sweep failed explicitly");
      assert(
        String(zRow.last_error).includes("final attempt"),
        "lastError names the final-attempt give-up",
      );
      assert(zRow.finished_at != null, "finished_at stamped on the explicit failure");
      const sweepZ2 = await insertSweep(db, [wZ]);
      let rethrown2: any = null;
      try {
        await handleZoomMatchSweep(
          { payload: { sweepId: sweepZ2 }, attemptCount: 0, maxAttempts: 3 } as any,
          deps,
        );
      } catch (e: any) {
        rethrown2 = e;
      }
      assert(!!rethrown2, "non-final attempt rethrows for a queue retry");
      const z2Row = await getSweep(db, sweepZ2);
      assert(z2Row.status === "running", "non-final attempt leaves the sweep running for the retry");
      world.listError = null;
      await db.execute(sql`UPDATE zoom_match_sweeps SET status = 'failed' WHERE id = ${sweepZ2}`);

      // G6. Status-poll self-heal: running + silent + zero live jobs →
      // bounded resume with a fresh resume-numbered key; past the budget →
      // explicit failure, never an eternal zombie.
      const wQ = { from: "2026-05-01", to: "2026-05-30" };
      const sweepQ = await insertSweep(db, [wQ]);
      await db.execute(sql`
        UPDATE zoom_match_sweeps
        SET updated_at = NOW() - interval '3 minutes', started_at = NOW()
        WHERE id = ${sweepQ}
      `);
      const statusEnqueues: any[] = [];
      const statusDeps = { enqueue: async (input: any) => void statusEnqueues.push(input) } as any;
      const st1 = await getZoomMatchSweepStatus(statusDeps);
      assert(st1?.id === sweepQ, "status returns the stuck sweep");
      assert(st1.resumed === true && st1.resumeCount === 1, "silent dead chain triggers resume 1");
      assert(
        statusEnqueues.length === 1 &&
          statusEnqueues[0].dedupeKey === `zoom_match_sweep:${sweepQ}:resume:1`,
        "resume continuation uses a fresh resume-numbered dedupe key",
      );
      assert(
        statusEnqueues[0].payload?.step === 0,
        "resume job is authorized for the sweep's current committed step",
      );
      const qRow = await getSweep(db, sweepQ);
      assert(
        qRow.status === "running" && Number(qRow.phase_state_json?.resumeCount) === 1,
        "sweep stays running with the resume budget consumption persisted",
      );
      const st2 = await getZoomMatchSweepStatus(statusDeps);
      assert(
        st2.resumed === false && statusEnqueues.length === 1,
        "fresh activity (the resume bump) suppresses immediate re-resume",
      );
      await db.execute(sql`
        UPDATE zoom_match_sweeps
        SET updated_at = NOW() - interval '3 minutes',
            phase_state_json = jsonb_set(phase_state_json, '{resumeCount}', to_jsonb(${SWEEP_MAX_AUTO_RESUMES}::int))
        WHERE id = ${sweepQ}
      `);
      const st3 = await getZoomMatchSweepStatus(statusDeps);
      assert(st3.status === "failed", "exhausted resume budget fails the sweep explicitly");
      assert(
        statusEnqueues.length === 1,
        "no further resume enqueued once the budget is exhausted",
      );
      const qRowFailed = await getSweep(db, sweepQ);
      assert(
        String(qRowFailed.last_error).includes("failing explicitly") && qRowFailed.finished_at != null,
        "exhaustion failure is loud and terminal",
      );
    },
    {
      tables: [
        "users",
        "clients",
        "client_contacts",
        "raw_communication_records",
        "zoom_match_sweeps",
        "zoom_transcript_match_analyses",
        "work_queue",
      ],
    },
  );

  console.log(`\nTest run: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test crashed:", err);
    process.exit(1);
  });
