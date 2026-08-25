/**
 * Task #2691 — Front Console "Bring it to 100%" orchestrator.
 *
 * The Front Console default view answers two questions for a non-technical CEO:
 *   1. "Are all our Front messages logged?"  → `% of messages logged`
 *      (`applied / front_total`, all-time, message-grain) + counts + bar.
 *   2. "How are they classified?"            → matched / unmatched / dismissed.
 * Plus ONE idempotent button — "Bring it to 100%" — that orchestrates the
 * EXISTING recovery drivers (the summary read path makes no Front calls; the
 * button only hands off to those drivers, no duplicated drain logic) toward the
 * honest reachable ceiling. Task #2705: plan-limited months are NO longer all
 * parked behind a Front plan upgrade — those whose conversation-search workaround
 * can still enumerate their messages are chased as reachable work; only the
 * genuinely-unreachable residue (search itself plan-limits) needs a plan upgrade.
 * The target stays a finite ceiling ("as complete as Front allows"), never an
 * infinite spinner.
 *
 * Drivers orchestrated, in order (all individually idempotent + breaker-aware):
 *   A. runHistoricalRecovery({})                 — re-pull the reachable INGEST gap.
 *   B. applyFinishFrontMessageGrainCoverage      — finish/raise every in-scope
 *                                                  month to a message-grain denom.
 *   C. applyReachFrontCoverageFull               — drive each sub-floor month's
 *                                                  numerator toward 100% of msgs.
 *   D. applyRecoverFrontPlanLimitedMessages      — (Task #2705) recover the
 *                                                  plan-limited months C retires
 *                                                  via the conversation-search
 *                                                  workaround (approximate, but
 *                                                  reachable — not parked behind a
 *                                                  Front plan upgrade).
 *   E. applyBackfillFrontMessageAttribution      — close the APPLY gap + attribute
 *                                                  matched-conversation messages.
 *
 * Data sources (all cache-only / DB-only, zero Front calls on the read path):
 *   - getFrontAnalyticsCoverageSummary()  (frontAnalyticsCoverage.ts) — all-time
 *     + per-month coverage; we re-derive the plan-limited split from byMonth.
 *   - getFrontMessageGrainStats(db)       (frontMessageGrainStats.ts) — classification.
 *
 * Public API docs reviewed (per replit.md rule): Front Analytics export is a
 * plan-gated feature — months beyond the plan's analytics retention window
 * return no per-message history, which is exactly the `plan_limited` cap this
 * module honors (https://dev.frontapp.com/reference/analytics — analytics export
 * endpoints; https://help.front.com/ — Analytics plan retention). No Front
 * endpoint is called here; the orchestrated drivers own all Front I/O and each
 * already routes its token refresh through the single-flight + auth breaker.
 *
 * Prior tasks consulted: #2685 (three-lens reconciliation / one honest source of
 * truth), #2436/#2439/#2440 (all-time totals sum in-scope message-grain months
 * only), #2511 (finish message-grain control), #1920 (reach full coverage),
 * #2662 (attribution backfill), #1963 (drainFront122kBacklog orchestration
 * template), and the memory notes front-historical-coverage-plan-limited.md +
 * cross-instance-drain-lock.md.
 */

import type {
  FrontBringTo100MonthInput,
  FrontBringTo100Target,
  FrontMessageGrainStats,
} from "@shared/frontConsoleMetrics";
import {
  computeFrontBringTo100Target,
  frontCoverageGrain,
  isFrontMonthSearchRecoverable,
} from "@shared/frontConsoleMetrics";

export type FrontBringTo100Classification = {
  total: number;
  matched: number;
  unmatched: number;
  dismissed: number;
  matchRate: number;
};

export type FrontBringTo100RollupStatus =
  | "working" // a driver drain / recovery job is actively running
  | "blocked" // Front auth breaker tripped — reconnect required
  | "up_to_date" // no reachable work remains, nothing running
  | "work_remaining"; // reachable work remains, nothing running (press the button)

export type FrontBringTo100Summary = {
  target: FrontBringTo100Target;
  classification: FrontBringTo100Classification;
  status: FrontBringTo100RollupStatus;
  /** One plain-English sentence rolling up the live state. */
  statusDetail: string;
  /** True when the Front auth breaker is tripped (button can't run). */
  blocked: boolean;
  /** True when a non-critical-sweeps kill switch or queue pause is active. */
  queuePaused: boolean;
  pauseReason: string | null;
  generatedAt: string;
};

/** Cheap in-memory Front auth breaker check (no Front call). */
async function isFrontAuthBlocked(): Promise<boolean> {
  try {
    const { frontAuthBreakerActive } = await import("./frontAuthBreaker");
    return frontAuthBreakerActive();
  } catch {
    return false;
  }
}

/**
 * Whether the historical-recovery queue is paused (kill switch or queue drain).
 * Optional in unit-test contexts — returns {paused:false} when the modules are
 * unavailable.
 */
async function getRecoveryPauseState(): Promise<{
  paused: boolean;
  reason: string | null;
}> {
  try {
    const { isQueuePaused } = await import("./queueDrainControl");
    if (isQueuePaused("front_historical_recovery")) {
      return { paused: true, reason: "queue_drain_paused" };
    }
  } catch {
    // optional in tests
  }
  return { paused: false, reason: null };
}

/**
 * Build the simple Front Console summary. Cache-only / DB-only — never calls
 * Front. `db` is the request-scoped api pool handle (the classification query
 * runs on it; coverage uses its own getDb internally).
 */
export async function getFrontBringTo100Summary(
  db: Parameters<
    typeof import("./frontMessageGrainStats").getFrontMessageGrainStats
  >[0],
): Promise<FrontBringTo100Summary> {
  const { getFrontAnalyticsCoverageSummary } = await import(
    "./frontAnalyticsCoverage"
  );
  const { getFrontMessageGrainStats } = await import("./frontMessageGrainStats");
  const { getFrontBringTo100DrainRunning } = await import(
    "./prodActionsRegistry"
  );
  const { listRecoveryJobs } = await import("./frontHistoricalRecovery");

  const coverage = await getFrontAnalyticsCoverageSummary();

  // Re-derive the in-scope, message-grain month set the all-time totals sum
  // (Task #2436): at/after the adoption floor AND message-grain denominator.
  // Split each by plan-limited (analyticsPlanLimitedAt != null) for the
  // reachable-target math.
  const adoptionFloorMonth = coverage.adoptionDate
    ? coverage.adoptionDate.slice(0, 7)
    : null;
  // Task #2722 — feed BOTH message-grain AND conversation-grain in-scope months
  // to the ceiling math (excluding only "unknown"-grain transitional rows, which
  // never contributed before). `computeFrontBringTo100Target` is now the single
  // grain authority: it counts message-grain months toward the ceiling and
  // EXCLUDES conversation-grain months (per-message enumeration not yet
  // complete) so a long conversation active in several months is not
  // double-counted across them. Passing them through lets the function surface an
  // honest "still counted by conversation" note instead of silently dropping
  // them in the caller. The headline ceiling numbers are unchanged.
  const months: FrontBringTo100MonthInput[] = coverage.byMonth
    .filter((m) => {
      const atOrAfterFloor =
        adoptionFloorMonth == null || m.month >= adoptionFloorMonth;
      const grain = frontCoverageGrain(m.denominatorUnit);
      return atOrAfterFloor && (grain === "messages" || grain === "conversations");
    })
    .map((m) => ({
      frontTotalMessages: m.frontTotalMessages,
      fetchedIntoNobull: m.fetchedIntoNobull,
      appliedIntoNobull: m.appliedIntoNobull,
      ingestGap: m.ingestGap,
      applyGap: m.applyGap,
      planLimited: m.analyticsPlanLimitedAt != null,
      // Task #2705 — a plan-limited month is still reachable via the
      // conversation-search workaround unless search itself hard-failed; that
      // gap is chased by the recover-plan-limited step, not parked behind a
      // plan upgrade. Pure classification from the row's own status/error.
      searchRecoverable:
        m.analyticsPlanLimitedAt != null && isFrontMonthSearchRecoverable(m),
      // Task #2745 — a NON-plan-limited month whose deep per-message search walk
      // is proven exhausted: its residual ingest gap is genuinely un-fetchable,
      // parked out of reachable work so the button converges instead of spinning
      // forever on a gap no driver can close.
      deepSearchExhausted: m.deepSearchExhausted,
      // Task #2722 — grain marker so the ceiling can exclude conversation-grain
      // months from the message-grain denominator.
      denominatorUnit: m.denominatorUnit,
    }));
  const target = computeFrontBringTo100Target(months);

  const grain: FrontMessageGrainStats = await getFrontMessageGrainStats(db);
  const classification: FrontBringTo100Classification = {
    total: grain.total,
    matched: grain.matched,
    unmatched: grain.unmatched,
    dismissed: grain.nonMatchable,
    matchRate: grain.matchRate,
  };

  const [blocked, pause, recoveryJobs] = await Promise.all([
    isFrontAuthBlocked(),
    getRecoveryPauseState(),
    listRecoveryJobs().catch(() => [] as Awaited<ReturnType<typeof listRecoveryJobs>>),
  ]);
  const drains = getFrontBringTo100DrainRunning();
  const anyDrainRunning =
    drains.finish || drains.attribution || drains.reach || drains.planLimited;
  const anyRecoveryActive = recoveryJobs.some(
    (j) => j.status === "running" || j.status === "queued",
  );
  const working = anyDrainRunning || anyRecoveryActive;

  // Task #2710 — surface the Step 2.5 materializer's per-month progress so the
  // operator sees materialization advancing while the drain runs, instead of a
  // stale coverage % until the self-heal cadence finishes. Best-effort: any read
  // error degrades to "" so the headline still renders.
  const { getMaterializationProgressDetail } = await import(
    "./frontAppliedConvMaterializer"
  );
  const materializationDetail = await getMaterializationProgressDetail(db);

  const { status, statusDetail } = rollUpStatus({
    blocked,
    working,
    target,
    pauseReason: pause.reason,
    materializationDetail,
  });

  return {
    target,
    classification,
    status,
    statusDetail,
    blocked,
    queuePaused: pause.paused,
    pauseReason: pause.reason,
    generatedAt: new Date().toISOString(),
  };
}

function rollUpStatus(input: {
  blocked: boolean;
  working: boolean;
  target: FrontBringTo100Target;
  pauseReason: string | null;
  /**
   * Task #2710 — per-month Step 2.5 materializer progress sentence, e.g.
   * "materializing messages for 2025-09: 1,200 of 3,737 conversations done".
   * Empty when nothing is materializing.
   */
  materializationDetail?: string;
}): { status: FrontBringTo100RollupStatus; statusDetail: string } {
  const { blocked, working, target, pauseReason } = input;
  const materializationNote = input.materializationDetail
    ? ` ${input.materializationDetail}.`
    : "";
  const remaining = target.reachableRemainingWork;
  // Task #2705 — the button NOW also recovers plan-limited months whose
  // conversation-search workaround can still enumerate their messages (counted
  // in `reachableRemainingWork`), so the "needs a plan upgrade" note is reserved
  // for the genuinely-unreachable residual only. A separate clause explains the
  // search-recovered portion is an approximation.
  const searchNote =
    target.searchRecoverableRemainder > 0
      ? ` That includes ${target.searchRecoverableRemainder.toLocaleString()} message(s) from older months Front's plan no longer exports directly — the button recovers those by searching Front conversation-by-conversation (an approximation, but close enough).`
      : "";
  const planNote =
    target.planLimitedRemainder > 0
      ? ` ${target.planLimitedRemainder.toLocaleString()} more message(s) sit in months even a conversation search can't reach — closing those needs a Front plan upgrade, not this button.`
      : "";
  // Task #2745 — a NON-plan-limited residual we already searched exhaustively:
  // reach ran the deep per-message search walk to exhaustion and Front no longer
  // returns those messages, so no button can log them. Reported honestly so the
  // headline doesn't imply the button is stuck on reachable work.
  const searchExhaustedNote =
    target.searchExhaustedRemainder > 0
      ? ` ${target.searchExhaustedRemainder.toLocaleString()} message(s) were searched for exhaustively but Front no longer returns them — they can't be logged by any button.`
      : "";
  // Task #2722 — older months still counted by conversation (per-message
  // enumeration not finished) are excluded from this percentage on purpose, so a
  // long conversation spanning several months isn't counted once per month. The
  // "Bring it to 100%" steps convert those to message grain, after which they
  // count in-window, once each.
  const convGrainNote =
    target.conversationGrainExcludedMonths > 0
      ? ` ${target.conversationGrainExcludedMonths.toLocaleString()} older month(s) are still counted by conversation rather than message and are left out of this percentage until per-message enumeration finishes — so a long conversation active across several months isn't double-counted. The button drives those toward message grain.`
      : "";
  if (blocked) {
    return {
      status: "blocked",
      statusDetail:
        "Front is disconnected — reconnect Front in the Integrations Hub, then press the button again." +
        planNote +
        searchExhaustedNote,
    };
  }
  if (working) {
    return {
      status: "working",
      statusDetail:
        `Working on it — ${remaining.toLocaleString()} reachable message(s) still being logged in the background. This page updates live; you can leave and come back.` +
        materializationNote +
        searchNote +
        planNote +
        searchExhaustedNote +
        convGrainNote,
    };
  }
  if (remaining === 0) {
    return {
      status: "up_to_date",
      statusDetail:
        `Everything Front lets us log is logged (${target.reachableTargetPct.toFixed(1)}% of messages).` +
        planNote +
        searchExhaustedNote +
        convGrainNote,
    };
  }
  const pauseNote =
    pauseReason === "queue_drain_paused"
      ? " (Historical recovery is paused in Queue Drain Control — un-pause it for the re-pull step to run.)"
      : "";
  return {
    status: "work_remaining",
    statusDetail:
      `${remaining.toLocaleString()} reachable message(s) are not logged yet. Press "Bring it to 100%" to log them.` +
      searchNote +
      pauseNote +
      planNote +
      searchExhaustedNote +
      convGrainNote,
  };
}

export type FrontBringTo100RunStep = {
  label: string;
  state: "applied" | "not-needed" | "blocked" | "error" | "skipped";
  detail: string;
};

export type FrontBringTo100RunResult = {
  started: boolean;
  blocked: boolean;
  steps: FrontBringTo100RunStep[];
  detail: string;
};

/**
 * Idempotent orchestration: kick the existing recovery drivers in order. Each is
 * individually idempotent and breaker-aware, so a second press while drains are
 * still running is a safe no-op (the underlying drains return "already running"
 * / "not-needed"). Returns immediately — the drivers hand off to background
 * drains / recovery jobs whose live state the status endpoint rolls up.
 */
export async function startFrontBringTo100(
  actorId: string | null,
): Promise<FrontBringTo100RunResult> {
  const steps: FrontBringTo100RunStep[] = [];

  // Breaker-gate the whole run: if Front auth is dead, none of the Front-driven
  // steps can make progress, so report blocked without starting anything.
  if (await isFrontAuthBlocked()) {
    return {
      started: false,
      blocked: true,
      steps: [],
      detail:
        "Front is disconnected — reconnect Front in the Integrations Hub before bringing coverage to 100%.",
    };
  }

  // Step A — re-pull the reachable ingest gap via historical recovery. Default
  // windows are auto-generated from the gaps; a RecoveryConcurrencyCapError just
  // means a recovery run is already in flight (idempotent — treat as started).
  try {
    const pause = await getRecoveryPauseState();
    if (pause.paused) {
      steps.push({
        label: "1.historical_recovery_repull",
        state: "skipped",
        detail:
          "Historical recovery is paused in Queue Drain Control — skipped the re-pull step (other steps still ran).",
      });
    } else {
      const { runHistoricalRecovery } = await import("./frontHistoricalRecovery");
      await runHistoricalRecovery({});
      steps.push({
        label: "1.historical_recovery_repull",
        state: "applied",
        detail: "Started a historical-recovery re-pull for the reachable ingest gap.",
      });
    }
  } catch (err: any) {
    const name = err?.name ?? "";
    const msg = err?.message ?? String(err);
    if (name === "RecoveryConcurrencyCapError" || /concurrenc|already/i.test(msg)) {
      steps.push({
        label: "1.historical_recovery_repull",
        state: "not-needed",
        detail: "A historical-recovery run is already in progress.",
      });
    } else {
      steps.push({
        label: "1.historical_recovery_repull",
        state: "error",
        detail: msg,
      });
    }
  }

  // Steps B–E — drive the existing convergent prod-action drivers (grain → reach
  // → recover plan-limited → attribution). Each is idempotent; a press while one
  // is running returns pending/not-needed and starts nothing new.
  const {
    applyFinishFrontMessageGrainCoverage,
    applyReachFrontCoverageFull,
    applyRecoverFrontPlanLimitedMessages,
    applyBackfillFrontMessageAttribution,
  } = await import("./prodActionsRegistry");

  const driverSteps: Array<{
    label: string;
    run: () => Promise<{ state: string; detail?: string }>;
  }> = [
    {
      label: "2.finish_message_grain",
      run: () => applyFinishFrontMessageGrainCoverage(actorId),
    },
    {
      label: "3.reach_full_coverage",
      run: () => applyReachFrontCoverageFull(actorId),
    },
    // Task #2705 — also recover the plan-limited months via the conversation
    // search workaround (the months step 3 retires once their convergence
    // budget is spent). Idempotent + breaker-aware; no-op when its switch is
    // OFF or no recoverable plan-limited month remains.
    {
      label: "4.recover_plan_limited",
      run: () => applyRecoverFrontPlanLimitedMessages(actorId),
    },
    {
      label: "5.attribution_backfill",
      run: () => applyBackfillFrontMessageAttribution(actorId),
    },
  ];

  for (const { label, run } of driverSteps) {
    try {
      const outcome = await run();
      const state =
        outcome.state === "applied"
          ? "applied"
          : outcome.state === "blocked"
            ? "blocked"
            : outcome.state === "error"
              ? "error"
              : "not-needed";
      steps.push({
        label,
        state: state as FrontBringTo100RunStep["state"],
        detail: outcome.detail ?? "",
      });
    } catch (err: any) {
      steps.push({ label, state: "error", detail: err?.message ?? String(err) });
    }
  }

  const anyBlocked = steps.some((s) => s.state === "blocked");
  const anyStarted = steps.some(
    (s) => s.state === "applied" || s.state === "not-needed",
  );
  const detail = steps.map((s) => `${s.label}=${s.state}`).join(" | ");
  return {
    started: anyStarted,
    blocked: anyBlocked && !anyStarted,
    steps,
    detail,
  };
}
