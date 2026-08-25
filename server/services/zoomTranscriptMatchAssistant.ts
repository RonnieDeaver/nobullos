// @db-pool-intent: mixed
// Route-called entry points (startZoomMatchSweep, getZoomMatchSweepStatus,
// listZoomMatchWorkbenchCalls, requestZoomMatchReanalysis) run in API request
// context on the API pool; the queue handlers (advanceZoomMatchSweep,
// processZoomMatchGuessRecord) run inside the work scheduler's
// runWithWorkerDb wrapper on the worker pool.
//
// @cross-instance-safe: no periodic scheduler — all work is operator-
// triggered. The sweep-start insert is guarded by a single-statement
// INSERT … WHERE NOT EXISTS (status='running') so concurrent starts on two
// instances collapse to one row, and every work_queue enqueue is dedupe-keyed
// (continuations use deterministic per-step keys) so duplicate enqueues
// collapse via wq_dedupe_key_idx.
//
// Task #4057 — Zoom Transcript Match Assistant (manual year-back sweep).
//
// A separate, manually triggered tool on the Zoom admin panel that sweeps the
// past 12 months of Zoom cloud recordings, drives transcript backfill for
// records that never got one, runs a cheap-tier AI pass over each
// transcript-bearing call still unmatched (no client assigned), and feeds a
// review workbench where an operator confirms (or overrides) each guessed
// client. AI guesses are NEVER auto-applied — assignment happens only through
// the operator's explicit action, which reuses the existing manual-reassign
// semantics (server/services/zoomManualReassign.ts).
//
// Durability model: one `zoom_match_sweeps` row per sweep carries all
// progress (per-window discovery status, phase, counters, keyset cursors) so
// the panel can poll it across reloads and restarts. The sweep advances via
// self-re-enqueueing work-queue jobs on the `maintenance` class — each run
// does one bounded slice (one listing window, one transcript batch, one
// analysis-enqueue batch) and re-enqueues a deterministic continuation, so a
// crash mid-slice retries idempotently:
//
//   discovery   — per ~30-day window: paginated recordings listing →
//                 reconciliation-identical durable events + apply-job
//                 enqueues (same dedupe keys, so meetings already ingested by
//                 webhooks/reconciliation collapse instead of duplicating).
//   transcripts — waits for the discovery apply jobs to drain, then walks
//                 window records still missing transcripts through the
//                 existing per-record backfill (terminal-unavailable + Rev AI
//                 fallback semantics included) with `pastWindowOverride` for
//                 meetings older than the backfill window.
//   analysis    — enqueues one dedupe-keyed analyze job per eligible call;
//                 the sweep row completes here while analyze jobs keep
//                 bumping its counters as results land incrementally.
//
// Failure semantics: Zoom auth-gate/permanent errors fail the sweep loudly
// (lastError names the fix) instead of reporting honest-looking zeros; the
// global `non_critical_sweeps` kill switch parks new starts and fails an
// in-flight sweep with an explicit "re-run once released" error.
//
// Durability contract (each advance = one bounded slice):
//   • Every slice commits progress + counter deltas + step N→N+1 in ONE
//     compare-and-set UPDATE guarded on phase_state_json.step, and only the
//     CAS winner enqueues the step-keyed continuation (…:s<N+1>:…) whose
//     PAYLOAD carries the step it is authorized to execute. Raced twins of
//     the same step are serialized by the CAS — the loser returns without
//     counting or enqueueing.
//   • Continuation jobs are authorization tokens, not just dedupe keys
//     (work-queue dedupe only covers live jobs — completed keys stop
//     conflicting): an advance whose payload step no longer matches the
//     row's committed step (lease-expiry ghost, replay after successors
//     completed) performs NO slice work and enqueues nothing while another
//     live job owns the chain — replays can never fork the chain into
//     parallel lineages or repeat external work.
//   • A crash after the commit but before/around the enqueue is healed by
//     the queue retrying the same job: the retry fails the step match,
//     finds NO live continuation, and enqueues a heal job authorized for
//     the CURRENT committed step — the chain resumes without re-executing
//     the crashed job's already-committed slice.
//   • A transcript record whose backfill THROWS holds the cursor (bounded
//     by TRANSCRIPT_RECORD_MAX_ATTEMPTS) and then becomes an explicit entry
//     in phaseState.transcriptFailures — never a silent cursor skip.
//   • If the advance job fails its final attempt, the handler marks the
//     sweep failed with the real error before the dead-letter; if the chain
//     dies without the handler running (SIGKILL, reaper dead-letter), the
//     status poll detects "running + silent + no live job" and re-enqueues
//     a continuation, bounded by SWEEP_MAX_AUTO_RESUMES before failing
//     explicitly.

import { sql } from "drizzle-orm";

import { getDb, withDbAttribution } from "../db";
import { isKillSwitchEnabled, type KillSwitchName } from "./killSwitches";
import { enqueueJob, registerHandler } from "./workScheduler";
import { ZOOM_TRANSCRIPT_BACKFILL_HOURS } from "./workerConfig";
import type { WorkQueueJob } from "@shared/schema";
import {
  emptyZoomMatchSweepCounters,
  type ZoomMatchSweep,
  type ZoomMatchSweepCounters,
  type ZoomMatchSweepPhaseState,
  type ZoomMatchSweepWindow,
} from "@shared/schema";

export const ZOOM_MATCH_SWEEP_QUEUE = "zoom_match_sweep";
export const ZOOM_MATCH_ANALYZE_QUEUE = "zoom_match_analyze";

/** Sweep coverage: the task-mandated 12 months, in ≤30-day listing windows. */
const SWEEP_LOOKBACK_DAYS = 365;
const MAX_WINDOW_DAYS = 30;
/** Records walked through transcript backfill per job run (bounded slice). */
const TRANSCRIPT_BATCH_SIZE = 8;
/** Analyze jobs enqueued per job run. */
const ANALYSIS_ENQUEUE_BATCH_SIZE = 300;
/** 30s between "are the apply jobs drained yet?" checks, capped. */
const APPLY_DRAIN_WAIT_MS = 30_000;
const APPLY_DRAIN_MAX_WAITS = 40;
/** A running sweep with no row update for this long is considered stalled. */
export const SWEEP_STALL_MS = 30 * 60 * 1000;
/** Attempts for a transcript record whose backfill THROWS before the sweep
 * records an explicit failure and moves the cursor past it. (Returned
 * outcomes — unavailable/failed/… — are terminal on the first pass; this
 * bounds only thrown errors, which leave the record still 'pending'.) */
export const TRANSCRIPT_RECORD_MAX_ATTEMPTS = 3;
/** Delay before re-attempting a thrown transcript record. */
const TRANSCRIPT_RETRY_DELAY_MS = 30_000;
/** Cap on the explicit per-record failure list kept in phase state. */
const TRANSCRIPT_FAILURES_CAP = 100;
/** A running sweep silent this long with NO live queue job = broken chain;
 * the status poll self-heals it (bounded resumes, then explicit failure). */
export const SWEEP_RESUME_SILENCE_MS = 2 * 60 * 1000;
export const SWEEP_MAX_AUTO_RESUMES = 5;
/** Workbench "low confidence" filter threshold (UI mirrors this value). */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;
/** Model-call budget per record before the analysis parks as failed. */
export const ZOOM_MATCH_GUESS_MAX_ATTEMPTS = 3;
/** Transcript excerpt caps — VTT speaker labels live near the start, and
 * wrap-up/next-steps talk (rich client signal) lives at the end. */
const TRANSCRIPT_HEAD_CHARS = 12_000;
const TRANSCRIPT_TAIL_CHARS = 2_000;

const KILL_SWITCH_MESSAGE =
  "The non_critical_sweeps kill switch is enabled — start the sweep again once it is released.";

// ── Pure: sweep window math ───────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Non-overlapping ≤30-day windows covering the past 365 days, newest first
 * (recent calls are the actionable ones, so their results land first).
 */
export function computeSweepWindows(now: Date): Array<{ from: string; to: string }> {
  const overallStart = new Date(now.getTime() - SWEEP_LOOKBACK_DAYS * DAY_MS);
  const windows: Array<{ from: string; to: string }> = [];
  let cursorEnd = now;
  while (cursorEnd.getTime() >= overallStart.getTime()) {
    const candidateStart = new Date(cursorEnd.getTime() - (MAX_WINDOW_DAYS - 1) * DAY_MS);
    const start = candidateStart.getTime() < overallStart.getTime() ? overallStart : candidateStart;
    windows.push({ from: toDateStr(start), to: toDateStr(cursorEnd) });
    cursorEnd = new Date(start.getTime() - DAY_MS);
  }
  return windows;
}

// ── Injectable deps (ESM static imports can't be monkey-patched in tests,
//    so external-world edges arrive as a bundle with real defaults) ────────

export interface ZoomMatchSweepDeps {
  /** Paginated per-user recordings listing for one ≤30-day window. */
  listRecordings(from: string, to: string): Promise<any[]>;
  /** Durable pipeline event ingest (dedupe-keyed). */
  ingestEvent(input: {
    sourceSystem: string;
    sourceEventType: string;
    sourceObjectId: string;
    dedupeKey: string;
    payloadJson: unknown;
    status: string;
    replayable: boolean;
  }): Promise<{ id: string; deduplicated: boolean }>;
  /** Durable work-queue enqueue (dedupe-keyed). */
  enqueue(input: {
    queueName: string;
    workloadClass: string;
    priority?: number;
    payload?: unknown;
    dedupeKey?: string;
    maxAttempts?: number;
    retryAt?: Date;
  }): Promise<unknown>;
  /** Existing per-record transcript backfill (terminal + Rev AI semantics). */
  processTranscriptRecord(
    recordId: string,
    opts?: { pastWindowOverride?: boolean },
  ): Promise<"backfilled" | "skipped" | "failed" | "unavailable" | "revai_enqueued">;
  isKillSwitchEnabled(name: KillSwitchName): boolean;
  now(): Date;
  /** Live (pending/leased/processing) sweep-queue jobs for this sweep,
   * excluding the currently executing job — the stale-job guard's
   * chain-liveness probe. */
  countLiveSweepJobs(sweepId: string, excludeJobId?: string): Promise<number>;
}

export function defaultZoomMatchSweepDeps(): ZoomMatchSweepDeps {
  return {
    listRecordings: async (from, to) => {
      const { listRecordingsWindowPaginated } = await import("./zoomIntegration");
      return listRecordingsWindowPaginated(from, to);
    },
    ingestEvent: async (input) => {
      const { ingestEvent } = await import("./pipelineProcessor");
      return ingestEvent(input as any) as Promise<{ id: string; deduplicated: boolean }>;
    },
    enqueue: (input) => enqueueJob(input as any),
    processTranscriptRecord: async (recordId, opts) => {
      const { processTranscriptBackfillRecord } = await import("./zoomIntegration");
      return processTranscriptBackfillRecord(recordId, opts);
    },
    isKillSwitchEnabled: (name) => isKillSwitchEnabled(name),
    now: () => new Date(),
    countLiveSweepJobs: (sweepId, excludeJobId) =>
      withDbAttribution("zoom-match-assistant:live-jobs", async () => {
        const res: any = await getDb().execute(sql`
          SELECT COUNT(*)::int AS n FROM work_queue
          WHERE queue_name = ${ZOOM_MATCH_SWEEP_QUEUE}
            AND status IN ('pending', 'leased', 'processing')
            AND payload->>'sweepId' = ${sweepId}
            ${excludeJobId ? sql`AND id != ${excludeJobId}` : sql``}
        `);
        return Number(rowsOf(res)[0]?.n ?? 0);
      }),
  };
}

// ── Sweep row helpers ─────────────────────────────────────────────────────

function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : res?.rows ?? [];
}

async function loadSweep(sweepId: string): Promise<any | null> {
  return withDbAttribution("zoom-match-assistant:load-sweep", async () => {
    const res: any = await getDb().execute(sql`
      SELECT * FROM zoom_match_sweeps WHERE id = ${sweepId} LIMIT 1
    `);
    return rowsOf(res)[0] ?? null;
  });
}

/**
 * Atomic per-key counter increments (jsonb_set chain over the ORIGINAL
 * column value in one UPDATE). The sweep job and the per-record analyze jobs
 * both bump counters on the same row; per-key increments in single
 * statements mean concurrent writers can't lose each other's updates the
 * way a read-modify-write of the whole counters object would.
 */
async function incrementSweepCounters(
  sweepId: string,
  deltas: Partial<ZoomMatchSweepCounters>,
): Promise<void> {
  const entries = Object.entries(deltas).filter(([, v]) => typeof v === "number" && v !== 0);
  if (entries.length === 0) return;
  let expr = sql`counters_json`;
  for (const [key, delta] of entries) {
    expr = sql`jsonb_set(${expr}, ${`{${key}}`}::text[], to_jsonb(COALESCE((counters_json->>${key})::int, 0) + ${delta}))`;
  }
  await withDbAttribution("zoom-match-assistant:counters", async () => {
    await getDb().execute(sql`
      UPDATE zoom_match_sweeps
      SET counters_json = ${expr}, updated_at = NOW()
      WHERE id = ${sweepId}
    `);
  });
}

async function updateSweep(
  sweepId: string,
  fields: {
    status?: string;
    phase?: string;
    windowsJson?: ZoomMatchSweepWindow[];
    phaseStateJson?: ZoomMatchSweepPhaseState;
    lastError?: string | null;
    finished?: boolean;
  },
  opts?: {
    /** Guard terminal-failure writes so a stale/raced advance can never
     * clobber a row that already completed or failed. */
    onlyIfRunning?: boolean;
  },
): Promise<void> {
  const sets: any[] = [sql`updated_at = NOW()`];
  if (fields.status !== undefined) sets.push(sql`status = ${fields.status}`);
  if (fields.phase !== undefined) sets.push(sql`phase = ${fields.phase}`);
  if (fields.windowsJson !== undefined) {
    sets.push(sql`windows_json = ${JSON.stringify(fields.windowsJson)}::jsonb`);
  }
  if (fields.phaseStateJson !== undefined) {
    sets.push(sql`phase_state_json = ${JSON.stringify(fields.phaseStateJson)}::jsonb`);
  }
  if (fields.lastError !== undefined) sets.push(sql`last_error = ${fields.lastError}`);
  if (fields.finished) sets.push(sql`finished_at = NOW()`);
  await withDbAttribution("zoom-match-assistant:update-sweep", async () => {
    await getDb().execute(sql`
      UPDATE zoom_match_sweeps SET ${sql.join(sets, sql`, `)}
      WHERE id = ${sweepId} ${opts?.onlyIfRunning ? sql`AND status = 'running'` : sql``}
    `);
  });
}

/**
 * Single-statement compare-and-set slice commit: applies the slice's
 * progress markers, counter increments, and step N→N+1 atomically, guarded
 * on `phase_state_json.step` (and status='running'). Exactly one of two
 * racing advances for the same step can commit — the loser gets `false`
 * and must return WITHOUT enqueueing a continuation or counting anything.
 * Counter increments ride the same UPDATE as a jsonb_set chain over the
 * committed column value, so a lost race never double-counts; the
 * per-record analyze jobs keep using incrementSweepCounters, whose per-key
 * increments compose with this under row locking.
 */
async function commitSweepSlice(
  sweepId: string,
  expectedStep: number,
  fields: {
    status?: string;
    phase?: string;
    windowsJson?: ZoomMatchSweepWindow[];
    /** Written whole — MUST carry step: expectedStep + 1. */
    phaseStateJson: ZoomMatchSweepPhaseState;
    counterDeltas?: Partial<ZoomMatchSweepCounters>;
    lastError?: string | null;
    finished?: boolean;
  },
): Promise<boolean> {
  const sets: any[] = [sql`updated_at = NOW()`];
  if (fields.status !== undefined) sets.push(sql`status = ${fields.status}`);
  if (fields.phase !== undefined) sets.push(sql`phase = ${fields.phase}`);
  if (fields.windowsJson !== undefined) {
    sets.push(sql`windows_json = ${JSON.stringify(fields.windowsJson)}::jsonb`);
  }
  sets.push(sql`phase_state_json = ${JSON.stringify(fields.phaseStateJson)}::jsonb`);
  if (fields.lastError !== undefined) sets.push(sql`last_error = ${fields.lastError}`);
  if (fields.finished) sets.push(sql`finished_at = NOW()`);
  const deltaEntries = Object.entries(fields.counterDeltas ?? {}).filter(
    ([, v]) => typeof v === "number" && v !== 0,
  );
  if (deltaEntries.length > 0) {
    let expr = sql`counters_json`;
    for (const [key, delta] of deltaEntries) {
      expr = sql`jsonb_set(${expr}, ${`{${key}}`}::text[], to_jsonb(COALESCE((counters_json->>${key})::int, 0) + ${delta}))`;
    }
    sets.push(sql`counters_json = ${expr}`);
  }
  return withDbAttribution("zoom-match-assistant:commit-slice", async () => {
    const res: any = await getDb().execute(sql`
      UPDATE zoom_match_sweeps SET ${sql.join(sets, sql`, `)}
      WHERE id = ${sweepId}
        AND status = 'running'
        AND COALESCE((phase_state_json->>'step')::int, 0) = ${expectedStep}
      RETURNING id
    `);
    return rowsOf(res).length > 0;
  });
}

// ── Sweep start (route-called) ────────────────────────────────────────────

export type StartSweepResult =
  | { started: true; sweep: any }
  | { started: false; reason: "already_running" | "kill_switch"; message: string };

export async function startZoomMatchSweep(opts?: {
  startedByUserId?: string | null;
  now?: Date;
}): Promise<StartSweepResult> {
  if (isKillSwitchEnabled("non_critical_sweeps")) {
    return { started: false, reason: "kill_switch", message: KILL_SWITCH_MESSAGE };
  }

  const now = opts?.now ?? new Date();
  const windows: ZoomMatchSweepWindow[] = computeSweepWindows(now).map((w) => ({
    ...w,
    status: "pending" as const,
  }));
  const counters = emptyZoomMatchSweepCounters();
  const windowStart = new Date(now.getTime() - SWEEP_LOOKBACK_DAYS * DAY_MS);

  return withDbAttribution("zoom-match-assistant:start-sweep", async () => {
    // A stalled sweep (job dead-lettered mid-run, instance died) must not
    // block the tool forever — supersede it explicitly and loudly.
    await getDb().execute(sql`
      UPDATE zoom_match_sweeps
      SET status = 'failed',
          last_error = 'Superseded: sweep stalled (no progress for 30+ minutes) and a new sweep was started.',
          finished_at = NOW(),
          updated_at = NOW()
      WHERE status = 'running'
        AND updated_at < NOW() - make_interval(secs => ${SWEEP_STALL_MS / 1000})
    `);

    // Single-statement guarded insert: concurrent starts collapse to one row.
    const res: any = await getDb().execute(sql`
      INSERT INTO zoom_match_sweeps
        (status, phase, started_by_user_id, window_start, window_end, windows_json, counters_json, phase_state_json)
      SELECT 'running', 'discovery', ${opts?.startedByUserId ?? null},
             ${windowStart.toISOString()}::timestamp, ${now.toISOString()}::timestamp,
             ${JSON.stringify(windows)}::jsonb, ${JSON.stringify(counters)}::jsonb, '{}'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM zoom_match_sweeps WHERE status = 'running')
      RETURNING *
    `);
    const sweep = rowsOf(res)[0];
    if (!sweep) {
      return {
        started: false,
        reason: "already_running" as const,
        message: "A sweep is already running — wait for it to finish (or for the stall guard to supersede it).",
      };
    }

    await enqueueJob({
      queueName: ZOOM_MATCH_SWEEP_QUEUE,
      workloadClass: "maintenance",
      payload: { sweepId: sweep.id, step: 0 },
      dedupeKey: `zoom_match_sweep:${sweep.id}:start`,
      maxAttempts: 3,
    });
    console.log(`[ZoomMatchSweep] Sweep ${sweep.id} started (${windows.length} windows)`);
    return { started: true, sweep };
  });
}

// ── Sweep advance (worker-called; one bounded slice per run) ──────────────

export async function advanceZoomMatchSweep(
  sweepId: string,
  deps: ZoomMatchSweepDeps = defaultZoomMatchSweepDeps(),
  opts?: {
    /** Step this queue job was minted for (payload.step); null = direct
     * call without authorization semantics (legacy/manual). */
    jobStep?: number | null;
    /** work_queue id of the executing job, excluded from liveness. */
    excludeJobId?: string;
  },
): Promise<string> {
  const sweep = await loadSweep(sweepId);
  if (!sweep) return "skipped:sweep_missing";
  if (sweep.status !== "running") return `skipped:not_running:${sweep.status}`;

  if (deps.isKillSwitchEnabled("non_critical_sweeps")) {
    await updateSweep(
      sweepId,
      { status: "failed", lastError: KILL_SWITCH_MESSAGE, finished: true },
      { onlyIfRunning: true },
    );
    return "failed:kill_switch";
  }

  const windows: ZoomMatchSweepWindow[] = Array.isArray(sweep.windows_json)
    ? sweep.windows_json
    : [];
  const phaseState: ZoomMatchSweepPhaseState =
    sweep.phase_state_json && typeof sweep.phase_state_json === "object"
      ? sweep.phase_state_json
      : {};

  // Every advance commits exactly one CAS slice (step N→N+1); only the CAS
  // winner enqueues the next continuation, and every continuation's payload
  // carries the step it is authorized to execute (enforced by the stale-job
  // guard below — replays never blindly adopt the current slice).
  const step = Number(phaseState.step ?? 0);

  // Authorization guard. Work-queue dedupe only covers LIVE jobs, so a
  // lease-expired/replayed job can run again after its committed successors
  // already completed; executing "the current slice" from such a ghost
  // would fork the chain into parallel lineages that duplicate external
  // work. A job whose minted step no longer matches the committed step does
  // NO slice work: pure no-op while any other live job owns the chain, or —
  // when the chain is dead (crash after commit, before/around the enqueue)
  // — it enqueues a heal continuation authorized for the CURRENT step.
  if (opts?.jobStep != null && opts.jobStep !== step) {
    const live = await deps.countLiveSweepJobs(sweepId, opts.excludeJobId);
    if (live > 0) return "skipped:stale_job";
    await deps.enqueue({
      queueName: ZOOM_MATCH_SWEEP_QUEUE,
      workloadClass: "maintenance",
      payload: { sweepId, step },
      dedupeKey: `zoom_match_sweep:${sweepId}:s${step}:heal`,
      maxAttempts: 3,
    });
    console.warn(
      `[ZoomMatchSweep] stale job (minted step ${opts.jobStep}, committed ${step}) for sweep ${sweepId} found a dead chain — enqueued heal continuation for step ${step}`,
    );
    return "skipped:stale_job_healed";
  }

  const enqueueContinuation = async (label: string, retryAt?: Date) => {
    await deps.enqueue({
      queueName: ZOOM_MATCH_SWEEP_QUEUE,
      workloadClass: "maintenance",
      payload: { sweepId, step: step + 1 },
      dedupeKey: `zoom_match_sweep:${sweepId}:s${step + 1}:${label}`,
      maxAttempts: 3,
      ...(retryAt ? { retryAt } : {}),
    });
  };
  /** CAS lost — a raced twin already committed this step. Never count or
   * enqueue from the loser: the winner's continuation owns the chain. */
  const STALE = "skipped:stale_advance";

  try {
    if (sweep.phase === "discovery") {
      const idx = windows.findIndex((w) => w.status === "pending");
      if (idx === -1) {
        const committed = await commitSweepSlice(sweepId, step, {
          phase: "transcripts",
          phaseStateJson: { ...phaseState, applyDrainWaits: 0, step: step + 1 },
        });
        if (!committed) return STALE;
        await enqueueContinuation("tbegin", new Date(deps.now().getTime() + 15_000));
        return "discovery:complete";
      }

      const w = windows[idx];
      const meetings = await deps.listRecordings(w.from, w.to);
      let newMeetingEvents = 0;
      let newTranscriptEvents = 0;

      for (const meeting of meetings) {
        const meetingUuid = meeting.uuid || meeting.id?.toString();
        if (!meetingUuid) continue;
        const recordingFiles = meeting.recording_files || [];
        const recordingId =
          recordingFiles.length > 0
            ? recordingFiles[0]?.id?.toString() || ""
            : meetingUuid;

        // Reconciliation-identical dedupe keys + payload shape: meetings the
        // webhook/reconciliation lanes already ingested collapse here, and
        // the apply jobs behind these events are the SAME jobs those lanes
        // run — the sweep adds no second ingest path.
        const recordingResult = await deps.ingestEvent({
          sourceSystem: "zoom",
          sourceEventType: "recording_completed",
          sourceObjectId: meetingUuid,
          dedupeKey: `zoom:recording_completed:${meetingUuid}:${recordingId}`,
          payloadJson: { object: meeting, source: "match_assistant_sweep" },
          status: "received",
          replayable: true,
        });
        if (!recordingResult.deduplicated) {
          newMeetingEvents++;
          await deps.enqueue({
            queueName: "zoom_meeting_apply",
            workloadClass: "ingestion",
            priority: 200,
            payload: {
              sourceEventId: recordingResult.id,
              meetingUuid,
              meetingId: meeting.id?.toString() || meetingUuid,
              eventType: "recording_completed",
              source: "match_assistant_sweep",
            },
            dedupeKey: `zoom_meeting_apply:${recordingResult.id}`,
          });
        }

        const hasTranscript = recordingFiles.some((f: any) => f.file_type === "TRANSCRIPT");
        if (hasTranscript) {
          const transcriptResult = await deps.ingestEvent({
            sourceSystem: "zoom",
            sourceEventType: "transcript_completed",
            sourceObjectId: meetingUuid,
            dedupeKey: `zoom:transcript_completed:${meetingUuid}:${recordingId}`,
            payloadJson: { object: meeting, source: "match_assistant_sweep" },
            status: "received",
            replayable: true,
          });
          if (!transcriptResult.deduplicated) {
            newTranscriptEvents++;
            await deps.enqueue({
              queueName: "zoom_transcript_apply",
              workloadClass: "ingestion",
              priority: 200,
              payload: {
                sourceEventId: transcriptResult.id,
                meetingUuid,
                meetingId: meeting.id?.toString() || meetingUuid,
                eventType: "transcript_completed",
                source: "match_assistant_sweep",
              },
              dedupeKey: `zoom_transcript_apply:${transcriptResult.id}`,
            });
          }
        }
      }

      const nextWindows = windows.map((win, i) =>
        i === idx
          ? {
              ...win,
              status: "done" as const,
              meetingsFound: meetings.length,
              newMeetingEvents,
              newTranscriptEvents,
            }
          : win,
      );
      const committed = await commitSweepSlice(sweepId, step, {
        windowsJson: nextWindows,
        phaseStateJson: { ...phaseState, step: step + 1 },
        counterDeltas: {
          meetingsFound: meetings.length,
          meetingsIngestEnqueued: newMeetingEvents,
        },
      });
      if (!committed) return STALE;
      await enqueueContinuation(`w${idx + 1}`);
      console.log(
        `[ZoomMatchSweep] Sweep ${sweepId} window ${idx + 1}/${windows.length} (${w.from}..${w.to}): ${meetings.length} recordings, ${newMeetingEvents} new`,
      );
      return `discovery:window:${idx}`;
    }

    if (sweep.phase === "transcripts") {
      // Give the discovery phase's zoom_meeting_apply/zoom_transcript_apply
      // jobs time to land their records before enumerating what still lacks
      // a transcript — otherwise the walk would miss just-ingested meetings.
      const waits = phaseState.applyDrainWaits ?? 0;
      const pendingApplies: any = await withDbAttribution(
        "zoom-match-assistant:apply-drain-check",
        () =>
          getDb().execute(sql`
            SELECT COUNT(*)::int AS n FROM work_queue
            WHERE queue_name IN ('zoom_meeting_apply', 'zoom_transcript_apply')
              AND status IN ('pending', 'leased', 'processing')
          `),
      );
      const outstanding = Number(rowsOf(pendingApplies)[0]?.n ?? 0);
      if (outstanding > 0 && waits < APPLY_DRAIN_MAX_WAITS) {
        const committed = await commitSweepSlice(sweepId, step, {
          phaseStateJson: { ...phaseState, applyDrainWaits: waits + 1, step: step + 1 },
        });
        if (!committed) return STALE;
        await enqueueContinuation(
          `tw${waits + 1}`,
          new Date(deps.now().getTime() + APPLY_DRAIN_WAIT_MS),
        );
        return `transcripts:waiting_applies:${outstanding}`;
      }

      const cursor = phaseState.transcriptCursor ?? null;
      const batch: any = await withDbAttribution("zoom-match-assistant:transcript-batch", () =>
        getDb().execute(sql`
          SELECT id, timestamp FROM raw_communication_records
          WHERE source_type = 'zoom'
            AND timestamp >= ${new Date(sweep.window_start).toISOString()}::timestamp
            AND (transcript_status IS NULL OR transcript_status = 'pending')
            AND COALESCE(content_text, '') = ''
            AND client_id IS NULL
            ${
              cursor
                ? sql`AND (timestamp, id) > (${cursor.ts}::timestamp, ${cursor.id})`
                : sql``
            }
          ORDER BY timestamp ASC, id ASC
          LIMIT ${TRANSCRIPT_BATCH_SIZE}
        `),
      );
      const rows = rowsOf(batch);

      if (rows.length === 0) {
        const committed = await commitSweepSlice(sweepId, step, {
          phase: "analysis",
          phaseStateJson: {
            ...phaseState,
            transcriptCursor: null,
            transcriptRetry: null,
            step: step + 1,
          },
        });
        if (!committed) return STALE;
        await enqueueContinuation("abegin");
        return "transcripts:complete";
      }

      const deltas: Partial<ZoomMatchSweepCounters> = {};
      const bump = (key: keyof ZoomMatchSweepCounters) => {
        deltas[key] = (deltas[key] ?? 0) + 1;
      };
      const failures = [...(phaseState.transcriptFailures ?? [])];
      let retryState: { id: string; attempts: number } | null = null;
      let heldRecordId: string | null = null;
      // Cursor may only pass records that reached a TERMINAL outcome this
      // pass (returned outcome, or explicit give-up below) — never a record
      // whose backfill threw and is still pending.
      let lastTerminal: any = null;

      for (const row of rows) {
        const meetingMs = new Date(row.timestamp).getTime();
        const pastWindowOverride =
          deps.now().getTime() - meetingMs > ZOOM_TRANSCRIPT_BACKFILL_HOURS * 60 * 60 * 1000;
        try {
          const outcome = await deps.processTranscriptRecord(row.id, { pastWindowOverride });
          bump("transcriptsChecked");
          if (outcome === "backfilled") bump("transcriptsDownloaded");
          else if (outcome === "unavailable") bump("transcriptsUnavailable");
          else if (outcome === "revai_enqueued") bump("transcriptsGenerating");
          else if (outcome === "failed") bump("transcriptsFailed");
          else bump("transcriptsSkipped");
          lastTerminal = row;
        } catch (err: any) {
          // A THROW (unlike a returned terminal outcome) leaves the record
          // 'pending': advancing the keyset cursor past it would silently
          // drop it from the sweep forever. Hold the cursor and retry this
          // record with bounded attempts; only after
          // TRANSCRIPT_RECORD_MAX_ATTEMPTS does it become an explicit,
          // surfaced failure the cursor may pass.
          const prior = phaseState.transcriptRetry;
          const attempts = prior && prior.id === row.id ? prior.attempts + 1 : 1;
          const errMsg = String(err?.message ?? err).slice(0, 300);
          if (attempts >= TRANSCRIPT_RECORD_MAX_ATTEMPTS) {
            bump("transcriptsChecked");
            bump("transcriptsFailed");
            if (failures.length < TRANSCRIPT_FAILURES_CAP) {
              failures.push({ recordId: row.id, error: errMsg });
            }
            lastTerminal = row;
            console.warn(
              `[ZoomMatchSweep] transcript backfill for ${row.id} threw on all ${attempts} attempts — recorded as explicit failure: ${errMsg}`,
            );
            continue;
          }
          retryState = { id: row.id, attempts };
          heldRecordId = row.id;
          console.warn(
            `[ZoomMatchSweep] transcript backfill threw for ${row.id} (attempt ${attempts}/${TRANSCRIPT_RECORD_MAX_ATTEMPTS}) — holding cursor for retry: ${errMsg}`,
          );
          break;
        }
      }

      const nextCursor = lastTerminal
        ? { ts: new Date(lastTerminal.timestamp).toISOString(), id: lastTerminal.id }
        : (phaseState.transcriptCursor ?? null);
      const committed = await commitSweepSlice(sweepId, step, {
        phaseStateJson: {
          ...phaseState,
          transcriptCursor: nextCursor,
          transcriptRetry: retryState,
          transcriptFailures: failures,
          step: step + 1,
        },
        counterDeltas: deltas,
      });
      if (!committed) return STALE;
      await enqueueContinuation(
        heldRecordId ? `tr${retryState!.attempts}` : "t",
        heldRecordId ? new Date(deps.now().getTime() + TRANSCRIPT_RETRY_DELAY_MS) : undefined,
      );
      return heldRecordId
        ? `transcripts:retrying:${heldRecordId}:${retryState!.attempts}`
        : `transcripts:batch:${rows.length}`;
    }

    if (sweep.phase === "analysis") {
      const cursor = phaseState.analysisCursor ?? null;
      const batch: any = await withDbAttribution("zoom-match-assistant:analysis-batch", () =>
        getDb().execute(sql`
          SELECT r.id, r.timestamp
          FROM raw_communication_records r
          LEFT JOIN zoom_transcript_match_analyses a ON a.record_id = r.id
          WHERE r.source_type = 'zoom'
            AND r.timestamp >= ${new Date(sweep.window_start).toISOString()}::timestamp
            AND (r.transcript_status = 'ready' OR COALESCE(r.content_text, '') <> '')
            AND r.client_id IS NULL
            AND (
              a.id IS NULL
              OR (a.status = 'failed' AND a.attempts < ${ZOOM_MATCH_GUESS_MAX_ATTEMPTS})
            )
            ${
              cursor
                ? sql`AND (r.timestamp, r.id) > (${cursor.ts}::timestamp, ${cursor.id})`
                : sql``
            }
          ORDER BY r.timestamp ASC, r.id ASC
          LIMIT ${ANALYSIS_ENQUEUE_BATCH_SIZE}
        `),
      );
      const rows = rowsOf(batch);

      for (const row of rows) {
        await deps.enqueue({
          queueName: ZOOM_MATCH_ANALYZE_QUEUE,
          workloadClass: "maintenance",
          payload: { recordId: row.id, sweepId },
          dedupeKey: `zoom_match_analyze:${row.id}`,
          maxAttempts: 2,
        });
      }
      if (rows.length < ANALYSIS_ENQUEUE_BATCH_SIZE) {
        // Completion is honest about transcript records that kept throwing:
        // they are surfaced in lastError + transcriptFailures, never
        // silently absorbed into a clean-looking "completed".
        const failuresList = phaseState.transcriptFailures ?? [];
        const committed = await commitSweepSlice(sweepId, step, {
          status: "completed",
          phase: "done",
          phaseStateJson: { ...phaseState, analysisCursor: null, step: step + 1 },
          counterDeltas: rows.length > 0 ? { analysesEnqueued: rows.length } : undefined,
          lastError:
            failuresList.length > 0
              ? `Completed, but ${failuresList.length} record(s) failed transcript processing after ${TRANSCRIPT_RECORD_MAX_ATTEMPTS} attempts (see the sweep status failure list) — a new sweep retries them.`
              : null,
          finished: true,
        });
        if (!committed) return STALE;
        console.log(`[ZoomMatchSweep] Sweep ${sweepId} completed (${rows.length} analyses in final batch)`);
        return "complete";
      }

      const last = rows[rows.length - 1];
      const committed = await commitSweepSlice(sweepId, step, {
        phaseStateJson: {
          ...phaseState,
          analysisCursor: { ts: new Date(last.timestamp).toISOString(), id: last.id },
          step: step + 1,
        },
        counterDeltas: { analysesEnqueued: rows.length },
      });
      if (!committed) return STALE;
      await enqueueContinuation("a");
      return `analysis:batch:${rows.length}`;
    }

    return `skipped:phase:${sweep.phase}`;
  } catch (err: any) {
    // Permanent Zoom failures (auth gate engaged, dead credentials) fail the
    // sweep with an operator-actionable message; transient errors rethrow so
    // the work queue retries this slice.
    if (err?.name === "ZoomPermanentError") {
      await updateSweep(
        sweepId,
        {
          status: "failed",
          lastError: `Zoom authorization problem — reconnect Zoom, then re-run the sweep. (${String(err?.message ?? err).slice(0, 300)})`,
          finished: true,
        },
        { onlyIfRunning: true },
      );
      return "failed:zoom_permanent";
    }
    throw err;
  }
}

// ── AI match-guess analysis ───────────────────────────────────────────────

export interface ZoomMatchRosterEntry {
  id: string;
  firmName: string;
  contactName?: string | null;
  contactEmail?: string | null;
  emailDomains?: string[] | null;
  contacts?: Array<{ name?: string | null; emails?: string[] | null }>;
}

export interface ZoomMatchGuess {
  guessedClientId: string | null;
  confidence: number;
  rationale: string;
  names: string[];
  summary: string | null;
}

/**
 * Parse the model's strict-JSON reply. Throws on malformed replies (caller
 * records a retryable `failed`); an unknown client id degrades to a null
 * guess with the substitution noted in the rationale — never a made-up id.
 */
export function parseZoomMatchGuessReply(
  raw: string,
  validClientIds: Set<string>,
): ZoomMatchGuess {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`match-guess reply was not valid JSON (${raw.slice(0, 120)}…)`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("match-guess reply JSON was not an object");
  }

  let guessedClientId: string | null =
    typeof parsed.guessed_client_id === "string" && parsed.guessed_client_id.trim() !== ""
      ? parsed.guessed_client_id.trim()
      : null;
  let rationale = String(parsed.rationale ?? "").slice(0, 600);
  if (guessedClientId && !validClientIds.has(guessedClientId)) {
    rationale = `${rationale} (model referenced an unknown client id "${guessedClientId.slice(0, 60)}" — cleared)`.slice(0, 600);
    guessedClientId = null;
  }

  const confidenceRaw = Number(parsed.confidence);
  const confidence = guessedClientId === null && !Number.isFinite(confidenceRaw)
    ? 0
    : Math.min(1, Math.max(0, Number.isFinite(confidenceRaw) ? confidenceRaw : 0));

  const seen = new Set<string>();
  const names: string[] = [];
  for (const n of Array.isArray(parsed.names) ? parsed.names : []) {
    const name = String(n ?? "").trim().slice(0, 120);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= 40) break;
  }

  const summaryRaw = String(parsed.summary ?? "").trim();
  return {
    guessedClientId,
    confidence,
    rationale,
    names,
    summary: summaryRaw ? summaryRaw.slice(0, 2000) : null,
  };
}

/** Head+tail transcript excerpt (speaker labels up front, wrap-up at the end). */
export function buildTranscriptExcerpt(contentText: string): string {
  if (contentText.length <= TRANSCRIPT_HEAD_CHARS + TRANSCRIPT_TAIL_CHARS) {
    return contentText;
  }
  return `${contentText.slice(0, TRANSCRIPT_HEAD_CHARS)}\n[… transcript truncated …]\n${contentText.slice(-TRANSCRIPT_TAIL_CHARS)}`;
}

export function buildZoomMatchGuessPrompt(input: {
  topic: string;
  dateStr: string;
  durationMin: number | null;
  participants: Array<{ name?: string | null; email?: string | null; role?: string | null }>;
  transcriptExcerpt: string;
  roster: ZoomMatchRosterEntry[];
  existingSummary: string | null;
}): { system: string; user: string } {
  const rosterLines = input.roster.map((c) => {
    const contacts = (c.contacts ?? [])
      .slice(0, 4)
      .map((p) => {
        const emails = (p.emails ?? []).filter(Boolean).join(" / ");
        return [p.name, emails ? `<${emails}>` : null].filter(Boolean).join(" ");
      })
      .filter(Boolean);
    if (c.contactName || c.contactEmail) {
      contacts.unshift(
        [c.contactName, c.contactEmail ? `<${c.contactEmail}>` : null].filter(Boolean).join(" "),
      );
    }
    const domains = (c.emailDomains ?? []).filter(Boolean);
    return `${c.id} | ${c.firmName}${contacts.length ? ` | contacts: ${contacts.join(", ")}` : ""}${domains.length ? ` | domains: ${domains.join(", ")}` : ""}`;
  });

  const wantSummary = input.existingSummary === null;
  const system = [
    "You match Zoom call transcripts to the correct client account of a marketing agency.",
    "The client roster follows, one per line as: id | firm name | contacts | email domains.",
    "Decide which client the call is about/with, using participant names and emails, firm names spoken in the transcript, email domains, and the people mentioned.",
    "If the call is internal-only (agency team members, no identifiable client) or you cannot tell, use null.",
    "guessed_client_id MUST be exactly one id copied from the roster, or null — never invent an id.",
    "Confidence guide: 0.9+ the firm or its people are explicitly identified; 0.5–0.8 strong indirect evidence; below 0.5 weak inference.",
    "names: every person involved in the call — participants AND people referred to by name in the transcript (deduplicated, human names only).",
    wantSummary
      ? 'summary: 2–3 sentences on what the call was about.'
      : 'summary: set to "" — a summary already exists and will be reused.',
    "Respond with ONLY a JSON object, no prose, matching exactly:",
    `{
  "guessed_client_id": string | null,
  "confidence": number,
  "rationale": string,
  "names": string[],
  "summary": string
}`,
    "",
    "CLIENT ROSTER:",
    ...rosterLines,
  ].join("\n");

  const participantLines = input.participants
    .map((p) => {
      const bits = [p.name, p.email ? `<${p.email}>` : null, p.role ? `(${p.role})` : null]
        .filter(Boolean)
        .join(" ");
      return bits ? `- ${bits}` : null;
    })
    .filter(Boolean) as string[];

  const user = [
    `Meeting: "${input.topic}"`,
    `Date: ${input.dateStr}${input.durationMin ? ` — about ${input.durationMin} minutes` : ""}`,
    participantLines.length
      ? `Zoom participants:\n${participantLines.join("\n")}`
      : "Zoom participants: (none recorded)",
    ...(input.existingSummary
      ? [`Existing call summary (for context):\n${input.existingSummary.slice(0, 2000)}`]
      : []),
    "TRANSCRIPT:",
    input.transcriptExcerpt,
  ].join("\n\n");

  return { system, user };
}

export interface ZoomMatchGuessDeps {
  /** One cheap-tier chat call; returns the raw JSON reply + model name. */
  callModel(input: { system: string; user: string }): Promise<{ raw: string; model: string }>;
  now(): Date;
}

async function defaultCallModel(input: {
  system: string;
  user: string;
}): Promise<{ raw: string; model: string }> {
  const { openai } = await import("../routes/middleware");
  const { CHEAP_MODEL, reasoningEffortFor } = await import("../aiModels");
  const effort = reasoningEffortFor(CHEAP_MODEL);
  const resp = await openai.chat.completions.create(
    {
      model: CHEAP_MODEL,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      response_format: { type: "json_object" },
      // gpt-5-mini burns reasoning tokens from the same budget — leave
      // headroom above the (small) JSON reply.
      max_completion_tokens: 3000,
      ...(effort ? { reasoning_effort: effort } : {}),
    } as any,
    { timeout: 120_000, maxRetries: 1 },
  );
  return { raw: resp.choices[0]?.message?.content ?? "", model: CHEAP_MODEL };
}

export function defaultZoomMatchGuessDeps(): ZoomMatchGuessDeps {
  return {
    callModel: defaultCallModel,
    now: () => new Date(),
  };
}

async function loadClientRoster(): Promise<ZoomMatchRosterEntry[]> {
  return withDbAttribution("zoom-match-assistant:roster", async () => {
    // Archived/demo clients are excluded from the AI roster — a real call
    // can't belong to them, and the operator's dropdown is not limited by
    // this list.
    const res: any = await getDb().execute(sql`
      SELECT c.id, c.firm_name, c.contact_name, c.contact_email, c.email_domains,
             COALESCE(
               json_agg(json_build_object('name', cc.name, 'emails', cc.emails))
                 FILTER (WHERE cc.id IS NOT NULL),
               '[]'
             ) AS contacts
      FROM clients c
      LEFT JOIN client_contacts cc ON cc.client_id = c.id
      WHERE c.is_archived = false AND COALESCE(c.is_demo, false) = false
      GROUP BY c.id
      ORDER BY c.firm_name ASC
    `);
    return rowsOf(res).map((r: any) => ({
      id: String(r.id),
      firmName: String(r.firm_name ?? ""),
      contactName: r.contact_name ?? null,
      contactEmail: r.contact_email ?? null,
      emailDomains: Array.isArray(r.email_domains) ? r.email_domains : null,
      contacts: Array.isArray(r.contacts)
        ? r.contacts
        : typeof r.contacts === "string"
          ? JSON.parse(r.contacts)
          : [],
    }));
  });
}

export type ZoomMatchGuessOutcome =
  | "analyzed"
  | "failed"
  | "skipped_missing"
  | "skipped_not_zoom"
  | "skipped_no_transcript"
  | "skipped_already_analyzed"
  | "skipped_already_matched"
  | "skipped_exhausted";

export async function processZoomMatchGuessRecord(
  recordId: string,
  deps: ZoomMatchGuessDeps = defaultZoomMatchGuessDeps(),
  opts?: { force?: boolean; sweepId?: string | null },
): Promise<ZoomMatchGuessOutcome> {
  const force = opts?.force === true;
  const sweepId = opts?.sweepId ?? null;

  const bumpSweep = async (key: keyof ZoomMatchSweepCounters) => {
    if (sweepId) await incrementSweepCounters(sweepId, { [key]: 1 });
  };

  const record: any = await withDbAttribution("zoom-match-assistant:load-record", async () => {
    const res: any = await getDb().execute(sql`
      SELECT id, source_type, title, timestamp, content_text, participants_json,
             ai_summary, client_id, match_method, match_confidence, raw_payload_json
      FROM raw_communication_records
      WHERE id = ${recordId}
      LIMIT 1
    `);
    return rowsOf(res)[0] ?? null;
  });

  if (!record) {
    await bumpSweep("analysesSkipped");
    return "skipped_missing";
  }
  if (record.source_type !== "zoom") {
    await bumpSweep("analysesSkipped");
    return "skipped_not_zoom";
  }
  const transcript = String(record.content_text ?? "");
  if (transcript.trim() === "") {
    await bumpSweep("analysesSkipped");
    return "skipped_no_transcript";
  }

  const existing: any = await withDbAttribution("zoom-match-assistant:load-analysis", async () => {
    const res: any = await getDb().execute(sql`
      SELECT id, status, attempts FROM zoom_transcript_match_analyses
      WHERE record_id = ${recordId}
      LIMIT 1
    `);
    return rowsOf(res)[0] ?? null;
  });

  if (!force) {
    if (existing?.status === "analyzed") {
      await bumpSweep("analysesSkipped");
      return "skipped_already_analyzed";
    }
    if (existing?.status === "failed" && Number(existing.attempts ?? 0) >= ZOOM_MATCH_GUESS_MAX_ATTEMPTS) {
      await bumpSweep("analysesSkipped");
      return "skipped_exhausted";
    }
    // The assistant only guesses for UNMATCHED calls — any existing client
    // assignment (manual or auto, regardless of confidence) skips. Forced
    // per-call re-analysis (operator-explicit) bypasses via `force`.
    if (record.client_id !== null) {
      await bumpSweep("analysesSkipped");
      return "skipped_already_matched";
    }
  }

  const roster = await loadClientRoster();
  const participants: Array<{ name?: string; email?: string; role?: string }> = Array.isArray(
    record.participants_json,
  )
    ? record.participants_json
    : [];
  const existingSummary =
    typeof record.ai_summary === "string" && record.ai_summary.trim() !== ""
      ? record.ai_summary.trim()
      : null;
  const durationRaw = Number((record.raw_payload_json as any)?.duration);
  const durationMin = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;

  const prompt = buildZoomMatchGuessPrompt({
    topic: String(record.title ?? "Zoom meeting"),
    dateStr: record.timestamp ? new Date(record.timestamp).toISOString().split("T")[0] : "unknown",
    durationMin,
    participants,
    transcriptExcerpt: buildTranscriptExcerpt(transcript),
    roster,
    existingSummary,
  });

  const persist = async (fields: {
    status: "analyzed" | "failed";
    guess?: ZoomMatchGuess;
    summary?: string | null;
    summarySource?: string | null;
    model?: string | null;
    error?: string | null;
  }) => {
    const namesJson = fields.guess ? JSON.stringify(fields.guess.names) : null;
    await withDbAttribution("zoom-match-assistant:persist-analysis", async () => {
      await getDb().execute(sql`
        INSERT INTO zoom_transcript_match_analyses
          (record_id, sweep_id, status, guessed_client_id, confidence, rationale,
           call_summary, summary_source, names_json, model, error, attempts, analyzed_at)
        VALUES
          (${recordId}, ${sweepId}, ${fields.status},
           ${fields.guess?.guessedClientId ?? null}, ${fields.guess?.confidence ?? null},
           ${fields.guess?.rationale ?? null}, ${fields.summary ?? null},
           ${fields.summarySource ?? null}, ${namesJson}::jsonb, ${fields.model ?? null},
           ${fields.error ?? null}, 1, ${fields.status === "analyzed" ? sql`NOW()` : sql`NULL`})
        ON CONFLICT (record_id) DO UPDATE SET
          sweep_id = EXCLUDED.sweep_id,
          status = EXCLUDED.status,
          guessed_client_id = EXCLUDED.guessed_client_id,
          confidence = EXCLUDED.confidence,
          rationale = EXCLUDED.rationale,
          call_summary = EXCLUDED.call_summary,
          summary_source = EXCLUDED.summary_source,
          names_json = EXCLUDED.names_json,
          model = EXCLUDED.model,
          error = EXCLUDED.error,
          attempts = zoom_transcript_match_analyses.attempts + 1,
          analyzed_at = EXCLUDED.analyzed_at,
          updated_at = NOW()
      `);
    });
  };

  try {
    const { raw, model } = await deps.callModel(prompt);
    const guess = parseZoomMatchGuessReply(raw, new Set(roster.map((r) => r.id)));

    // Merge Zoom participant names in case the model under-reported.
    const seen = new Set(guess.names.map((n) => n.toLowerCase()));
    for (const p of participants) {
      const name = String(p?.name || p?.email || "").trim().slice(0, 120);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      guess.names.push(name);
      if (guess.names.length >= 60) break;
    }

    // Reuse the record's existing AI summary rather than re-billing for one.
    const summary = existingSummary ?? guess.summary;
    await persist({
      status: "analyzed",
      guess,
      summary,
      summarySource: existingSummary ? "existing" : "generated",
      model,
      error: null,
    });
    await bumpSweep("callsAnalyzed");
    console.log(
      `[ZoomMatchGuess] Analyzed "${record.title}" (${recordId}): guess=${guess.guessedClientId ?? "null"} conf=${guess.confidence.toFixed(2)}`,
    );
    return "analyzed";
  } catch (err: any) {
    await persist({
      status: "failed",
      error: String(err?.message ?? err).slice(0, 500),
    });
    await bumpSweep("analysesFailed");
    console.warn(
      `[ZoomMatchGuess] Analysis failed for ${recordId}: ${String(err?.message ?? err).slice(0, 200)}`,
    );
    return "failed";
  }
}

// ── Route-facing reads ────────────────────────────────────────────────────

export interface ZoomMatchStatusDeps {
  enqueue: ZoomMatchSweepDeps["enqueue"];
}

export function defaultZoomMatchStatusDeps(): ZoomMatchStatusDeps {
  return { enqueue: (input) => enqueueJob(input as any) };
}

export async function getZoomMatchSweepStatus(
  deps: ZoomMatchStatusDeps = defaultZoomMatchStatusDeps(),
): Promise<any | null> {
  return withDbAttribution("zoom-match-assistant:status", async () => {
    const res: any = await getDb().execute(sql`
      SELECT * FROM zoom_match_sweeps ORDER BY started_at DESC LIMIT 1
    `);
    const sweep = rowsOf(res)[0];
    if (!sweep) return null;
    const phaseState: ZoomMatchSweepPhaseState =
      sweep.phase_state_json && typeof sweep.phase_state_json === "object"
        ? sweep.phase_state_json
        : {};

    // Chain-liveness self-heal. A healthy running sweep always has exactly
    // one live continuation job; "running + silent + no live job" means the
    // chain died in a way the advance handler could not observe (instance
    // SIGKILLed post-commit, reaper dead-letter without a handler run).
    // State is durable in the row, so ANY future status poll performs the
    // recovery: re-enqueue a continuation with a fresh resume-numbered key,
    // bounded by SWEEP_MAX_AUTO_RESUMES — past the bound, fail explicitly
    // instead of resuming forever. The resumeCount CAS collapses concurrent
    // polls to a single resume.
    let resumed = false;
    if (sweep.status === "running") {
      const silentMs = Date.now() - new Date(sweep.updated_at).getTime();
      if (silentMs > SWEEP_RESUME_SILENCE_MS) {
        const live: any = await getDb().execute(sql`
          SELECT COUNT(*)::int AS n FROM work_queue
          WHERE queue_name = ${ZOOM_MATCH_SWEEP_QUEUE}
            AND status IN ('pending', 'leased', 'processing')
            AND payload->>'sweepId' = ${sweep.id}
        `);
        if (Number(rowsOf(live)[0]?.n ?? 0) === 0) {
          const resumeCount = Number(phaseState.resumeCount ?? 0);
          if (resumeCount >= SWEEP_MAX_AUTO_RESUMES) {
            const failMsg = `Sweep advance chain died ${SWEEP_MAX_AUTO_RESUMES} resumes in a row — failing explicitly. Re-run the sweep; already-completed work is skipped.`;
            await getDb().execute(sql`
              UPDATE zoom_match_sweeps
              SET status = 'failed', last_error = ${failMsg}, finished_at = NOW(), updated_at = NOW()
              WHERE id = ${sweep.id} AND status = 'running'
            `);
            sweep.status = "failed";
            sweep.last_error = failMsg;
          } else {
            const cas: any = await getDb().execute(sql`
              UPDATE zoom_match_sweeps
              SET phase_state_json = jsonb_set(COALESCE(phase_state_json, '{}'::jsonb), '{resumeCount}', to_jsonb(${resumeCount + 1}::int)),
                  updated_at = NOW()
              WHERE id = ${sweep.id} AND status = 'running'
                AND COALESCE((phase_state_json->>'resumeCount')::int, 0) = ${resumeCount}
              RETURNING id
            `);
            if (rowsOf(cas).length > 0) {
              await deps.enqueue({
                queueName: ZOOM_MATCH_SWEEP_QUEUE,
                workloadClass: "maintenance",
                payload: { sweepId: sweep.id, step: Number(phaseState.step ?? 0) },
                dedupeKey: `zoom_match_sweep:${sweep.id}:resume:${resumeCount + 1}`,
                maxAttempts: 3,
              });
              resumed = true;
              console.warn(
                `[ZoomMatchSweep] Sweep ${sweep.id} chain silent ${Math.round(silentMs / 1000)}s with no live job — re-enqueued continuation (resume ${resumeCount + 1}/${SWEEP_MAX_AUTO_RESUMES})`,
              );
            }
          }
        }
      }
    }

    const counters: ZoomMatchSweepCounters = {
      ...emptyZoomMatchSweepCounters(),
      ...(sweep.counters_json ?? {}),
    };
    const windows: ZoomMatchSweepWindow[] = Array.isArray(sweep.windows_json)
      ? sweep.windows_json
      : [];
    const analysesPending = Math.max(
      0,
      counters.analysesEnqueued -
        counters.callsAnalyzed -
        counters.analysesFailed -
        counters.analysesSkipped,
    );
    const stalled =
      sweep.status === "running" &&
      Date.now() - new Date(sweep.updated_at).getTime() > SWEEP_STALL_MS;
    return {
      id: sweep.id,
      status: sweep.status,
      phase: sweep.phase,
      startedByUserId: sweep.started_by_user_id,
      startedAt: sweep.started_at,
      finishedAt: sweep.finished_at,
      updatedAt: sweep.updated_at,
      lastError: sweep.last_error,
      windowStart: sweep.window_start,
      windowEnd: sweep.window_end,
      windowsTotal: windows.length,
      windowsDone: windows.filter((w) => w.status === "done").length,
      counters,
      analysesPending,
      stalled,
      step: Number(phaseState.step ?? 0),
      resumeCount: Number(phaseState.resumeCount ?? 0) + (resumed ? 1 : 0),
      resumed,
      transcriptFailures: phaseState.transcriptFailures ?? [],
    };
  });
}

export interface WorkbenchFilters {
  page: number;
  limit: number;
  assigned: "unassigned" | "all";
  month: string | null; // YYYY-MM
  confidence: "low" | "all";
  analyzed: "analyzed" | "all";
}

export async function listZoomMatchWorkbenchCalls(filters: WorkbenchFilters): Promise<{
  calls: any[];
  total: number;
  page: number;
  limit: number;
}> {
  const conds: any[] = [
    sql`r.source_type = 'zoom'`,
    sql`r.timestamp >= NOW() - make_interval(days => ${SWEEP_LOOKBACK_DAYS})`,
  ];
  if (filters.assigned === "unassigned") {
    conds.push(sql`r.client_id IS NULL`);
  }
  if (filters.month) {
    const [y, m] = filters.month.split("-").map((v) => parseInt(v, 10));
    const monthStart = new Date(Date.UTC(y, m - 1, 1));
    const monthEnd = new Date(Date.UTC(y, m, 1));
    conds.push(sql`r.timestamp >= ${monthStart.toISOString()}::timestamp`);
    conds.push(sql`r.timestamp < ${monthEnd.toISOString()}::timestamp`);
  }
  if (filters.confidence === "low") {
    conds.push(
      sql`a.status = 'analyzed' AND COALESCE(a.confidence, 0) < ${LOW_CONFIDENCE_THRESHOLD}`,
    );
  }
  if (filters.analyzed === "analyzed") {
    conds.push(sql`a.status IN ('analyzed', 'pending', 'failed')`);
  }

  const offset = (filters.page - 1) * filters.limit;
  return withDbAttribution("zoom-match-assistant:workbench-list", async () => {
    const res: any = await getDb().execute(sql`
      SELECT
        r.id, r.timestamp, r.title, r.transcript_status, r.client_id,
        r.match_method, r.match_confidence, r.ai_summary, r.participants_json,
        (r.raw_payload_json->>'duration') AS duration_min,
        (r.raw_payload_json->'zoomTranscriptUnavailable'->>'reason') AS transcript_unavailable_reason,
        (r.raw_payload_json->'zoomRevAiTranscription'->>'state') AS revai_state,
        (r.transcript_status = 'ready' OR COALESCE(r.content_text, '') <> '') AS has_transcript,
        cur.firm_name AS current_client_name,
        a.status AS analysis_status, a.guessed_client_id, a.confidence AS guess_confidence,
        a.rationale, a.call_summary, a.summary_source, a.names_json, a.model AS analysis_model,
        a.error AS analysis_error, a.analyzed_at,
        g.firm_name AS guessed_client_name,
        COUNT(*) OVER() AS total
      FROM raw_communication_records r
      LEFT JOIN zoom_transcript_match_analyses a ON a.record_id = r.id
      LEFT JOIN clients cur ON cur.id = r.client_id
      LEFT JOIN clients g ON g.id = a.guessed_client_id
      WHERE ${sql.join(conds, sql` AND `)}
      ORDER BY r.timestamp DESC, r.id DESC
      LIMIT ${filters.limit} OFFSET ${offset}
    `);
    const rows = rowsOf(res);
    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    const calls = rows.map((r: any) => ({
      id: r.id,
      timestamp: r.timestamp,
      title: r.title,
      durationMin: r.duration_min ? Number(r.duration_min) : null,
      transcriptStatus: r.transcript_status,
      transcriptUnavailableReason: r.transcript_unavailable_reason ?? null,
      revAiState: r.revai_state ?? null,
      hasTranscript: r.has_transcript === true,
      clientId: r.client_id,
      clientName: r.current_client_name ?? null,
      matchMethod: r.match_method,
      matchConfidence: r.match_confidence !== null ? Number(r.match_confidence) : null,
      participants: Array.isArray(r.participants_json) ? r.participants_json : [],
      aiSummary: r.ai_summary ?? null,
      analysis: r.analysis_status
        ? {
            status: r.analysis_status,
            guessedClientId: r.guessed_client_id ?? null,
            guessedClientName: r.guessed_client_name ?? null,
            confidence: r.guess_confidence !== null ? Number(r.guess_confidence) : null,
            rationale: r.rationale ?? null,
            summary: r.call_summary ?? null,
            summarySource: r.summary_source ?? null,
            names: Array.isArray(r.names_json)
              ? r.names_json
              : typeof r.names_json === "string"
                ? JSON.parse(r.names_json)
                : [],
            model: r.analysis_model ?? null,
            error: r.analysis_error ?? null,
            analyzedAt: r.analyzed_at ?? null,
          }
        : null,
    }));
    return { calls, total, page: filters.page, limit: filters.limit };
  });
}

// ── Forced re-analysis (route-called) ─────────────────────────────────────

export type ReanalyzeResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string };

export async function requestZoomMatchReanalysis(recordId: string): Promise<ReanalyzeResult> {
  const record: any = await withDbAttribution("zoom-match-assistant:reanalyze-load", async () => {
    const res: any = await getDb().execute(sql`
      SELECT id, source_type,
             (transcript_status = 'ready' OR COALESCE(content_text, '') <> '') AS has_transcript
      FROM raw_communication_records
      WHERE id = ${recordId}
      LIMIT 1
    `);
    return rowsOf(res)[0] ?? null;
  });
  if (!record || record.source_type !== "zoom") {
    return { ok: false, status: 404, error: "Zoom meeting not found" };
  }
  if (record.has_transcript !== true) {
    return { ok: false, status: 409, error: "This call has no transcript to analyze" };
  }

  // Flip (or create) the analysis row to 'pending' so the workbench shows
  // "re-analyzing" immediately; the analyze job overwrites it when it lands.
  await withDbAttribution("zoom-match-assistant:reanalyze-mark", async () => {
    await getDb().execute(sql`
      INSERT INTO zoom_transcript_match_analyses (record_id, status, attempts)
      VALUES (${recordId}, 'pending', 0)
      ON CONFLICT (record_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = NOW()
    `);
  });

  await enqueueJob({
    queueName: ZOOM_MATCH_ANALYZE_QUEUE,
    workloadClass: "maintenance",
    payload: { recordId, force: true },
    // Timestamped key: a force request must not collapse into an old
    // completed job for the same record.
    dedupeKey: `zoom_match_analyze:force:${recordId}:${Date.now()}`,
    maxAttempts: 2,
  });
  return { ok: true };
}

// ── Queue handlers ────────────────────────────────────────────────────────

export async function handleZoomMatchSweep(
  job: WorkQueueJob,
  deps?: ZoomMatchSweepDeps,
): Promise<{ cursor?: string } | void> {
  const payload = (job.payload ?? {}) as { sweepId?: string; step?: number };
  if (!payload.sweepId || typeof payload.sweepId !== "string") {
    console.warn("[ZoomMatchSweep] sweep job missing sweepId — completing as no-op");
    return { cursor: "skipped:no_sweep_id" };
  }
  try {
    const cursor = await advanceZoomMatchSweep(payload.sweepId, deps, {
      jobStep: typeof payload.step === "number" ? payload.step : null,
      excludeJobId: job.id,
    });
    return { cursor };
  } catch (err: any) {
    // Transient errors rethrow so the queue retries this slice — but on the
    // FINAL attempt the job is about to dead-letter, which would strand the
    // sweep 'running' with no live continuation. Mark it failed NOW with
    // the real error (the status poll's silence-based self-heal is only the
    // backstop for crashes where this handler never runs). Guarded to
    // running rows so a raced completion is never clobbered.
    const attemptsAfterThis = (job.attemptCount ?? 0) + 1;
    if (attemptsAfterThis >= (job.maxAttempts ?? 3)) {
      try {
        await updateSweep(
          payload.sweepId,
          {
            status: "failed",
            lastError: `Sweep advance failed on its final attempt: ${String(err?.message ?? err).slice(0, 300)} — re-run the sweep; already-completed work is skipped.`,
            finished: true,
          },
          { onlyIfRunning: true },
        );
      } catch (markErr: any) {
        console.warn(
          `[ZoomMatchSweep] could not mark sweep ${payload.sweepId} failed on final attempt: ${markErr?.message ?? markErr}`,
        );
      }
    }
    throw err;
  }
}

export async function handleZoomMatchAnalyze(
  job: WorkQueueJob,
): Promise<{ cursor?: string } | void> {
  const payload = (job.payload ?? {}) as {
    recordId?: string;
    sweepId?: string;
    force?: boolean;
  };
  if (!payload.recordId || typeof payload.recordId !== "string") {
    console.warn("[ZoomMatchGuess] analyze job missing recordId — completing as no-op");
    return { cursor: "skipped:no_record_id" };
  }
  const outcome = await processZoomMatchGuessRecord(payload.recordId, undefined, {
    force: payload.force === true,
    sweepId: payload.sweepId ?? null,
  });
  return { cursor: outcome };
}

export function registerZoomMatchAssistantHandlers(): void {
  registerHandler(ZOOM_MATCH_SWEEP_QUEUE, handleZoomMatchSweep);
  registerHandler(ZOOM_MATCH_ANALYZE_QUEUE, handleZoomMatchAnalyze);
}
