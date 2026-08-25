// @db-pool-intent: worker
//
// Task #3712 — AM coaching run orchestrator.
//
// One director-triggered background run analyzes every account manager who
// owns at least one active client. Liveness truth is the cross-instance
// worker-singleton advisory lock (`am-coaching-run`): a second start while a
// run is live anywhere in the cluster is rejected gracefully (409 at the
// route), and a `running` row whose instance died is recognized as an orphan
// the next time someone starts a run (we hold the lock, so nobody else can
// legitimately be mid-run) and is marked failed.
//
// Per-AM isolation: each AM's sample+analyze is wrapped in its own
// try/catch; a failure writes a `failed` report row and the run keeps going.
// Progress counters are bumped atomically after each AM so the UI can poll
// "N of M analyzed". After all AMs, a department-level synthesis pass dedupes
// common mistakes across the team; a synthesis failure downgrades to a note
// on the run rather than discarding the per-AM reports. The requester gets
// an in-app notification when the run finishes either way.
import { desc, eq, sql } from "drizzle-orm";
import { workerDb as db, runWithWorkerDb, withDbAttribution } from "../db";
import {
  amCoachingReports,
  amCoachingRuns,
  type AmCoachingRun,
} from "@shared/schema";
import { acquireWorkerSingletonLock } from "./crossInstanceLock";
import {
  listCoachedManagers,
  listInternalEmails,
  sampleAmCommunications,
  MIN_ATTRIBUTED_SAMPLES,
  type CoachedManager,
} from "./amCoachingSampler";
import {
  analyzeAmCoaching,
  synthesizeDepartment,
  AM_COACHING_MODEL_VERSION,
  type SynthesisInputReport,
} from "./amCoachingAnalysis";
import { notifyUser } from "./notifications/userInbox";

const LOCK_NAME = "am-coaching-run";
const LOG_PREFIX = "[am-coaching]";
/** Watchdog ceiling — a hung run loses the lock (and gets orphan-failed on
 * the next start) instead of blocking coaching forever. */
const MAX_RUN_HOLD_MS = 45 * 60_000;
/** How many AMs are analyzed concurrently. Small on purpose: each analysis
 * is one heavy QUALITY_MODEL call and the run is not latency-sensitive. */
const COACHING_CONCURRENCY = 2;

// In-flight background runs, keyed by run id — tests drain these instead of
// racing a fixed sleep (fire-and-forget work is otherwise unobservable).
const inFlightRuns = new Map<string, Promise<void>>();

export async function __test_awaitCoachingRuns(): Promise<void> {
  while (inFlightRuns.size > 0) {
    await Promise.allSettled([...inFlightRuns.values()]);
  }
}

export type StartCoachingRunResult =
  | { started: true; run: AmCoachingRun }
  | { started: false; reason: "already_running"; activeRun: AmCoachingRun | null };

/**
 * Start a coaching run across all AMs. Returns `started: false` when another
 * run is live anywhere in the cluster. The actual analysis continues in the
 * background; callers poll the run row for progress.
 */
export async function startAmCoachingRun(
  requestedByUserId: string,
): Promise<StartCoachingRunResult> {
  const lock = await acquireWorkerSingletonLock(LOCK_NAME, LOG_PREFIX, {
    maxHoldMs: MAX_RUN_HOLD_MS,
  });
  if (!lock) {
    const [activeRun] = await db
      .select()
      .from(amCoachingRuns)
      .where(eq(amCoachingRuns.status, "running"))
      .orderBy(desc(amCoachingRuns.startedAt))
      .limit(1);
    return { started: false, reason: "already_running", activeRun: activeRun ?? null };
  }

  let run: AmCoachingRun;
  let managers: CoachedManager[];
  try {
    // We hold the cluster-wide lock, so any still-`running` row is an orphan
    // from a crashed/redeployed instance — retire it instead of letting it
    // block the UI as a phantom active run.
    await db
      .update(amCoachingRuns)
      .set({
        status: "failed",
        error: "Interrupted — the instance running this analysis restarted mid-run.",
        finishedAt: new Date(),
      })
      .where(eq(amCoachingRuns.status, "running"));

    managers = await listCoachedManagers();
    const inserted = await db
      .insert(amCoachingRuns)
      .values({
        status: "running",
        requestedByUserId,
        totalManagers: managers.length,
        modelVersion: AM_COACHING_MODEL_VERSION,
      })
      .returning();
    run = inserted[0];
  } catch (err) {
    await lock.release();
    throw err;
  }

  const promise = runWithWorkerDb(() =>
    withDbAttribution("worker:am-coaching-run", () =>
      executeCoachingRun(run.id, managers, requestedByUserId),
    ),
  )
    .catch((err) => {
      console.error(`${LOG_PREFIX} run ${run.id} crashed:`, err);
    })
    .finally(async () => {
      inFlightRuns.delete(run.id);
      await lock.release().catch((releaseErr) => {
        console.error(`${LOG_PREFIX} lock release failed:`, releaseErr);
      });
    });
  inFlightRuns.set(run.id, promise);

  return { started: true, run };
}

async function executeCoachingRun(
  runId: string,
  managers: CoachedManager[],
  requestedByUserId: string,
): Promise<void> {
  let processed = 0;
  let failed = 0;
  const synthesisInputs: SynthesisInputReport[] = [];

  try {
    const internalEmails = await listInternalEmails();

    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < managers.length) {
        const manager = managers[nextIndex++];
        let amFailed = false;
        try {
          const sampleSet = await sampleAmCommunications(
            { id: manager.id, email: manager.email, name: manager.name },
            manager.clientIds,
            internalEmails,
          );

          if (sampleSet.attributedCount < MIN_ATTRIBUTED_SAMPLES) {
            // Explicit "insufficient data" — never fabricate coaching from
            // material the AM can't be verified in.
            await db.insert(amCoachingReports).values({
              runId,
              amUserId: manager.id,
              status: "insufficient_data",
              clientCount: sampleSet.clientCount,
              zoomSampleCount: sampleSet.zoomAttributedCount,
              emailSampleCount: sampleSet.emailAttributedCount,
              unattributedSampleCount: sampleSet.unattributedCount,
              insufficientData: true,
            });
          } else {
            const result = await analyzeAmCoaching(sampleSet);
            await db.insert(amCoachingReports).values({
              runId,
              amUserId: manager.id,
              status: "completed",
              clientCount: sampleSet.clientCount,
              zoomSampleCount: sampleSet.zoomAttributedCount,
              emailSampleCount: sampleSet.emailAttributedCount,
              unattributedSampleCount: sampleSet.unattributedCount,
              mistakesJson: result.mistakes,
              unattributedJson: result.unattributed,
              strengthsJson: result.strengths,
              zoomSummary: result.zoomSummary,
              emailSummary: result.emailSummary,
              coachingFocus: result.coachingFocus,
            });
            synthesisInputs.push({
              amUserId: manager.id,
              amName: manager.name,
              mistakes: result.mistakes.map((m) => ({
                title: m.title,
                description: m.description,
                severity: m.severity,
                channel: m.channel,
              })),
            });
          }
        } catch (err: any) {
          // Per-AM isolation: one AM's failure never kills the run.
          amFailed = true;
          const message = String(err?.message ?? err).slice(0, 2000);
          console.error(`${LOG_PREFIX} AM ${manager.id} failed:`, err);
          await db
            .insert(amCoachingReports)
            .values({
              runId,
              amUserId: manager.id,
              status: "failed",
              clientCount: manager.clientIds.length,
              error: message,
            })
            .catch((insertErr) => {
              console.error(`${LOG_PREFIX} failed-report insert failed:`, insertErr);
            });
        }

        processed += 1;
        if (amFailed) failed += 1;
        await db
          .update(amCoachingRuns)
          .set({
            processedManagers: sql`${amCoachingRuns.processedManagers} + 1`,
            ...(amFailed
              ? { failedManagers: sql`${amCoachingRuns.failedManagers} + 1` }
              : {}),
          })
          .where(eq(amCoachingRuns.id, runId));
      }
    };

    const workerCount = Math.max(1, Math.min(COACHING_CONCURRENCY, managers.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Department synthesis over the AMs that produced real reports. A
    // synthesis failure is a note on the run, not a run failure — the
    // per-AM reports are already written and valuable on their own.
    let synthesis = null;
    let synthesisError: string | null = null;
    try {
      synthesis = await synthesizeDepartment(synthesisInputs);
    } catch (err: any) {
      synthesisError = `Department synthesis failed: ${String(err?.message ?? err).slice(0, 500)}`;
      console.error(`${LOG_PREFIX} synthesis failed:`, err);
    }

    await db
      .update(amCoachingRuns)
      .set({
        status: "completed",
        departmentSynthesisJson: synthesis,
        error: synthesisError,
        finishedAt: new Date(),
      })
      .where(eq(amCoachingRuns.id, runId));

    await notifyRequester(requestedByUserId, runId, {
      title: "AM coaching reports are ready",
      body:
        `Analyzed ${processed} of ${managers.length} account manager${managers.length === 1 ? "" : "s"}` +
        (failed > 0 ? ` (${failed} failed)` : "") +
        ".",
    });
  } catch (err: any) {
    // Fatal (pre-loop or infrastructure) failure — mark the run failed so it
    // never lingers as a phantom "running" row.
    const message = String(err?.message ?? err).slice(0, 2000);
    console.error(`${LOG_PREFIX} run ${runId} failed:`, err);
    await db
      .update(amCoachingRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(amCoachingRuns.id, runId))
      .catch((updateErr) => {
        console.error(`${LOG_PREFIX} failed-run update failed:`, updateErr);
      });
    await notifyRequester(requestedByUserId, runId, {
      title: "AM coaching run failed",
      body: message.slice(0, 300),
    });
  }
}

async function notifyRequester(
  userId: string,
  runId: string,
  content: { title: string; body: string },
): Promise<void> {
  try {
    await notifyUser(userId, {
      category: "system",
      title: content.title,
      body: content.body,
      deepLink: `/churn?tab=team-coaching&view=coaching&runId=${runId}`,
      dedupeKey: `am-coaching-run:${runId}:${content.title}`,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} completion notification failed:`, err);
  }
}
