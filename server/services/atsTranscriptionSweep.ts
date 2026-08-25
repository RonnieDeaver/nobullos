// @db-pool-intent: worker
// @cross-instance-safe: every scheduled tick runs under
// withWorkerSingletonLock("ats_transcription_sweep") so only one instance
// sweeps at a time, and every write inside the sweep is a guarded
// conditional UPDATE from transcription_status='processing' (see
// atsTranscription.ts finalizers) — a racing callback delivery or a
// duplicate sweep converges idempotently as a 0-row no-op.
//
// Task #3963 (audit B-012) — bounded fallback sweeper for ATS Rev AI
// transcriptions whose completion callback never arrived (deploy downtime,
// Rev AI's 24 h retry budget exhausted, submission without a configured
// callback secret, or a pre-#3963 row stuck 'processing').
//
// Each tick (worker pool only):
//   * no-ops while the `ats_revai_transcription` kill switch is engaged
//     (deliberately NOT gated on `non_critical_sweeps`: this sweeper is the
//     correctness backstop for user-visible transcription status, not an
//     optional analysis lane);
//   * selects at most `limit` rows stuck 'processing' whose
//     COALESCE(transcription_updated_at, created_at) is older than
//     `minAgeMs` (oldest first — the callback normally lands well inside
//     that window);
//   * rows WITH a rev_job_id reconcile against Rev AI via the shared
//     `reconcileSubmissionAgainstRevAi` primitive (completed / empty /
//     typed rev_job_failed / typed job_not_found); jobs still in_progress
//     past `giveUpMs` (default 24 h — Rev AI's own webhook-retry horizon)
//     get a typed `job_timeout`;
//   * rows WITHOUT a rev_job_id older than `submitLostMs` get a typed
//     `submit_lost` (the submitting process died between claim and submit;
//     pre-#3963 such rows sat 'processing' forever) — terminal 'failed' is
//     re-claimable via the existing ATS retry endpoints;
//   * transient Rev AI/API errors are counted + logged and retried on the
//     next tick — never written as terminal state.
import { and, eq, inArray, sql } from "drizzle-orm";
import { workerDb, withDbAttribution } from "../db";
import { atsSubmissions } from "@shared/schema";
import {
  ensureKillSwitchesLoaded,
  isKillSwitchEnabled,
} from "./killSwitches";
import { withWorkerSingletonLock } from "./crossInstanceLock";
import {
  markTranscriptionTerminalFailure,
  reconcileSubmissionAgainstRevAi,
} from "./atsTranscription";

export const ATS_TRANSCRIPTION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const ATS_TRANSCRIPTION_SWEEP_BATCH_LIMIT = 25;
/** Rows younger than this are left alone — the callback normally wins. */
export const ATS_TRANSCRIPTION_SWEEP_MIN_AGE_MS = 5 * 60 * 1000;
/** Give-up window for jobs Rev AI still reports in_progress. */
export const ATS_TRANSCRIPTION_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** Give-up window for 'processing' rows that never got a rev_job_id. */
export const ATS_TRANSCRIPTION_SUBMIT_LOST_MS = 60 * 60 * 1000;

export interface AtsTranscriptionSweepSummary {
  skipped: "kill_switch" | null;
  scanned: number;
  completed: number;
  empty: number;
  /** Terminal typed failures written via reconcile (rev_job_failed / job_not_found / transcript_fetch_failed). */
  failed: number;
  /** Terminal `job_timeout` give-ups. */
  timedOut: number;
  /** Terminal `submit_lost` (stuck rows with no rev_job_id). */
  submitLost: number;
  /** Still legitimately in flight — left untouched. */
  inProgress: number;
  /** Finalized by a racing callback/worker mid-sweep — no-op here. */
  raced: number;
  /** Transient reconcile errors — retried next tick. */
  errors: number;
}

function emptySummary(skipped: AtsTranscriptionSweepSummary["skipped"]): AtsTranscriptionSweepSummary {
  return {
    skipped,
    scanned: 0,
    completed: 0,
    empty: 0,
    failed: 0,
    timedOut: 0,
    submitLost: 0,
    inProgress: 0,
    raced: 0,
    errors: 0,
  };
}

export async function sweepAtsTranscriptions(
  opts: {
    limit?: number;
    minAgeMs?: number;
    giveUpMs?: number;
    submitLostMs?: number;
    /**
     * Test-isolation seam: restricts the sweep to the caller's own fixture
     * rows so suites sharing a DB can never mutate each other's seeds.
     */
    restrictToSubmissionIds?: string[];
  } = {},
): Promise<AtsTranscriptionSweepSummary> {
  await ensureKillSwitchesLoaded();
  if (isKillSwitchEnabled("ats_revai_transcription")) {
    return emptySummary("kill_switch");
  }

  const limit = opts.limit ?? ATS_TRANSCRIPTION_SWEEP_BATCH_LIMIT;
  const minAgeMs = opts.minAgeMs ?? ATS_TRANSCRIPTION_SWEEP_MIN_AGE_MS;
  const giveUpMs = opts.giveUpMs ?? ATS_TRANSCRIPTION_GIVE_UP_MS;
  const submitLostMs = opts.submitLostMs ?? ATS_TRANSCRIPTION_SUBMIT_LOST_MS;

  const summary = emptySummary(null);
  if (opts.restrictToSubmissionIds && opts.restrictToSubmissionIds.length === 0) {
    return summary;
  }

  const now = Date.now();
  const staleBefore = new Date(now - minAgeMs);
  const effectiveTs = sql`COALESCE(${atsSubmissions.transcriptionUpdatedAt}, ${atsSubmissions.createdAt})`;
  const conditions = [
    eq(atsSubmissions.transcriptionStatus, "processing"),
    sql`${effectiveTs} < ${staleBefore}`,
  ];
  if (opts.restrictToSubmissionIds) {
    conditions.push(inArray(atsSubmissions.id, opts.restrictToSubmissionIds));
  }

  const rows = await workerDb
    .select()
    .from(atsSubmissions)
    .where(and(...conditions))
    .orderBy(effectiveTs)
    .limit(limit);

  for (const row of rows) {
    summary.scanned++;
    const effective = row.transcriptionUpdatedAt ?? row.createdAt ?? new Date(0);
    const ageMs = now - effective.getTime();

    if (!row.revJobId) {
      if (ageMs >= submitLostMs) {
        await markTranscriptionTerminalFailure(
          workerDb,
          row.id,
          "submit_lost",
          `submission stuck 'processing' without a Rev.ai job id for ${Math.round(ageMs / 60000)} min — the submitting process likely died before the job was created; retry via the ATS retry endpoint`,
        );
        summary.submitLost++;
      } else {
        summary.inProgress++;
      }
      continue;
    }

    try {
      const outcome = await reconcileSubmissionAgainstRevAi(workerDb, row);
      switch (outcome) {
        case "completed":
          summary.completed++;
          break;
        case "empty":
          summary.empty++;
          break;
        case "failed":
          summary.failed++;
          break;
        case "not_processing":
          summary.raced++;
          break;
        case "in_progress":
          if (ageMs >= giveUpMs) {
            await markTranscriptionTerminalFailure(
              workerDb,
              row.id,
              "job_timeout",
              `Rev.ai job ${row.revJobId} still not finished ${Math.round(ageMs / 3_600_000)}h after the last progress stamp — giving up; retry via the ATS retry endpoint`,
            );
            summary.timedOut++;
          } else {
            summary.inProgress++;
          }
          break;
      }
    } catch (err) {
      summary.errors++;
      console.warn(
        `[ats-transcription-sweep] Reconcile failed for submission ${row.id} (retried next tick):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const finalized =
    summary.completed + summary.empty + summary.failed + summary.timedOut + summary.submitLost;
  if (summary.scanned > 0) {
    console.log(
      `[ats-transcription-sweep] scanned=${summary.scanned} completed=${summary.completed} empty=${summary.empty} failed=${summary.failed} timedOut=${summary.timedOut} submitLost=${summary.submitLost} inProgress=${summary.inProgress} raced=${summary.raced} errors=${summary.errors}${finalized > 0 ? " (recovered work whose callback never arrived)" : ""}`,
    );
  }
  return summary;
}

// ── Scheduler ────────────────────────────────────────────────────────────

let sweepTimer: NodeJS.Timeout | null = null;

async function runSweepTick(): Promise<void> {
  try {
    await withWorkerSingletonLock(
      "ats_transcription_sweep",
      () =>
        withDbAttribution("maintenance:ats-transcription-sweep", () =>
          sweepAtsTranscriptions(),
        ),
      "[ats-transcription-sweep]",
      { maxHoldMs: 4 * 60 * 1000 },
    );
  } catch (err) {
    console.error("[ats-transcription-sweep] tick failed:", err);
  }
}

export function startAtsTranscriptionSweepScheduler(): void {
  if (sweepTimer) return;
  console.log(
    `[ats-transcription-sweep] scheduler started (interval ${ATS_TRANSCRIPTION_SWEEP_INTERVAL_MS}ms)`,
  );
  sweepTimer = setInterval(() => {
    void runSweepTick();
  }, ATS_TRANSCRIPTION_SWEEP_INTERVAL_MS);
  // Immediate first tick: a deploy/restart is exactly when callbacks were
  // most recently missed, so recover promptly instead of waiting a period.
  void runSweepTick();
}

export function stopAtsTranscriptionSweepScheduler(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
