// @db-pool-intent: worker
/**
 * Prod-actions engine (F7, Task #4154): registry-wide status computation,
 * apply-all / apply-one execution, run-history settlement, and the
 * module-load convergence-taxonomy guard.
 *
 * Relocated verbatim from the tail of server/services/prodActionsRegistry.ts.
 * Imports the composed PROD_ACTIONS from ./composition — never from the
 * public root (which would be a cycle).
 */

import { runWithWorkerDb, withDbAttribution } from "../../db";
import {
  getLastProdActionRunsForActions,
  recordProdActionRun,
  type ProdActionRunWithActor,
} from "../../storage/prodActionRuns";
import {
  getProdActionSelfHealReadout,
  getFailureAlertThreshold,
  getFailureAlertEnabled,
  DEFAULT_FAILURE_ALERT_THRESHOLD,
  type SelfHealActionReadout,
  type SelfHealLastRunSummary,
} from "../prodActionSelfHeal";
import {
  type ProdAction,
  type ProdActionConvergence,
  type ProdActionOutcome,
  type ProdActionStatus,
} from "./kernel";
import { PROD_ACTIONS } from "./composition";
import { registerModuleStateResetForTest } from "../moduleStateReset";
import { acquireProdActionManualLock } from "../crossInstanceLock";


/**
 * Task #4054 — registry-level framework guard. Every registered action
 * MUST declare its convergence class, and a `continuous` action MUST have
 * an always-on loop that drains it (self-heal enrollment or a `loopHealth`
 * probe for an external scheduler). Runs at module load so a violating
 * action can never ship silently: the process fails loudly at boot and in
 * every test that imports the registry, and the taxonomy guard test
 * (tests/prod-actions-convergence-taxonomy.test.ts) exercises the same
 * invariants against synthetic violations.
 *
 * This is the structural backstop for the "badge hits zero and stays
 * there" contract: a new action either converges after one apply (its
 * feeder is closed at ingest / terminally stamped), or it names the loop
 * that keeps it drained — there is no third, silently-recurring option.
 */
export function assertProdActionConvergenceInvariants(
  actions: readonly ProdAction[] = PROD_ACTIONS,
): void {
  const seen = new Set<string>();
  for (const action of actions) {
    if (seen.has(action.id)) {
      throw new Error(
        `[prod-actions] duplicate action id "${action.id}" in registry`,
      );
    }
    seen.add(action.id);
    const conv = action.convergence as ProdActionConvergence | undefined;
    if (!conv || (conv.kind !== "converging" && conv.kind !== "continuous")) {
      throw new Error(
        `[prod-actions] action "${action.id}" must declare convergence: ` +
          `{ kind: "converging" } (one apply settles it) or ` +
          `{ kind: "continuous", loop, loopHealth? } (routine inflow re-arms it and a named loop drains it).`,
      );
    }
    if (conv.kind === "continuous") {
      if (typeof conv.loop !== "string" || conv.loop.trim().length === 0) {
        throw new Error(
          `[prod-actions] continuous action "${action.id}" must name the always-on loop that drains it (convergence.loop).`,
        );
      }
      if (!action.selfHeal && typeof conv.loopHealth !== "function") {
        throw new Error(
          `[prod-actions] continuous action "${action.id}" has neither self-heal enrollment nor a loopHealth probe — ` +
            `a continuous pending feed needs an always-on drain loop, otherwise the CEO badge can never reach zero. ` +
            `Either enroll it (selfHeal: { cadenceMs, backoffMs }), give convergence.loopHealth a probe for its external scheduler, ` +
            `or close its feeder at ingest time and declare it converging.`,
        );
      }
      // Task #4762 — the converging-only declarations make no sense on a
      // continuous action: its drain story IS the named loop.
      if (action.humanGate) {
        throw new Error(
          `[prod-actions] continuous action "${action.id}" must not declare humanGate — ` +
            `a continuous action's drain path is its named loop (convergence.loop), not a human.`,
        );
      }
      if (action.manualLever) {
        throw new Error(
          `[prod-actions] continuous action "${action.id}" must not be a manual lever — ` +
            `a lever is fired as a deliberate individual choice, which contradicts a routinely re-fed pending feed.`,
        );
      }
      if (action.servedPurpose) {
        throw new Error(
          `[prod-actions] continuous action "${action.id}" must not declare servedPurpose — ` +
            `retirement probes are for converging levers / one-shot residue actions.`,
        );
      }
    }
    if (conv.kind === "converging") {
      // Task #4762 — REQUIRED drain declaration: every converging action
      // must state how it reaches zero WITHOUT a human pressing it —
      // self-heal enrollment (the scheduler presses it), manual lever (the
      // lever is availability, not work — its status never feeds the
      // badge), or an explicit, panel-surfaced human-gate reason. Exactly
      // one; the paths are mutually exclusive by construction:
      if (action.manualLever && action.selfHeal) {
        throw new Error(
          `[prod-actions] converging action "${action.id}" declares BOTH manualLever and selfHeal — ` +
            `a lever must never auto-fire (its whole point is deliberate individual choice).`,
        );
      }
      if (action.humanGate && (action.selfHeal || action.manualLever)) {
        throw new Error(
          `[prod-actions] converging action "${action.id}" declares humanGate alongside ` +
            `${action.selfHeal ? "selfHeal" : "manualLever"} — the drain declarations are mutually exclusive: ` +
            `an enrolled or lever action already has its no-human drain story.`,
        );
      }
      if (!action.selfHeal && !action.manualLever && !action.humanGate) {
        throw new Error(
          `[prod-actions] converging action "${action.id}" declares NO drain path — every converging action must ` +
            `state how it reaches zero without a human: enroll it in self-heal (selfHeal: { cadenceMs, backoffMs }) ` +
            `if one automatic press safely settles it, mark it manualLever: true if firing must be a deliberate ` +
            `individual choice, or declare humanGate: { reason } naming exactly why a human is genuinely required ` +
            `(the panel surfaces the reason beside the amber row). Silent default-manual-press is no longer an option.`,
        );
      }
      if (
        action.humanGate &&
        (typeof action.humanGate.reason !== "string" ||
          action.humanGate.reason.trim().length === 0)
      ) {
        throw new Error(
          `[prod-actions] converging action "${action.id}" declares humanGate with an empty reason — ` +
            `the reason is operator-facing (rendered beside the amber row) and must say why a human is required.`,
        );
      }
    }
  }
}


export interface ProdActionStatusRow {
  id: string;

  title: string;

  description: string;

  change: string;

  status: ProdActionStatus;
  /**
   * Task #2086 — true when this action has opted into self-heal via
   * `ProdAction.selfHeal` (the auto-healer may apply it on a cadence).
   */

  selfHealEligible: boolean;
  /**
   * Task #2086 — the durable last automatic-run readout for this action
   * (last run time, outcome, rows affected, next-eligible time), or null
   * when it is not self-heal-eligible or the auto-healer has not run it.
   */

  selfHeal: SelfHealActionReadout | null;
  /**
   * Task #4019 — true for manual levers (excluded from Apply-all; fired
   * individually via POST /api/admin/prod-actions/:actionId/apply). The
   * panel renders these in a dedicated Manual levers section with their
   * own button instead of the Apply-all lane.
   */
  manualLever: boolean;
  /** Typed destructive confirmation required by this manual lever, if any. */
  destructiveConfirmation?: {
    phrase: string;
    warning: string;
  };
  /**
   * Task #4054 — the action's declared convergence class (serializable
   * projection: the `loopHealth` closure is evaluated server-side and
   * reported via `autoManaged` / `autoManagedDetail`, never shipped).
   */
  convergence: { kind: "converging" } | { kind: "continuous"; loop: string };
  /**
   * Task #4054 — true when this row is a `continuous` action whose status
   * is `pending` while its draining loop is verifiably healthy. Such rows
   * are healthy always-on maintenance: they are EXCLUDED from `active`
   * (the needs-attention badge) and surfaced in the calm `autoManaged`
   * bucket instead. `error` / `blocked` rows are never auto-managed.
   */

  autoManaged: boolean;
  /** Task #4054 — human-readable loop-health reason for the row's bucket. */

  autoManagedDetail?: string;
  /**
   * Task #4762 — the action's declared human-gate reason (converging
   * actions that are neither enrolled nor levers). Rendered beside the
   * amber row so the operator sees WHY this one legitimately waits for a
   * human instead of draining itself.
   */
  humanGate?: { reason: string };
  /**
   * Task #4762 — true when the action's served-purpose probe reports its
   * target state fully reached: the lever's job is done. The panel drops
   * the row from the Manual levers section and shows it in History with
   * `retiredNote`. The action stays registered (Apply-all audit contract
   * and the per-action endpoint are unaffected).
   */
  retired?: true;
  /** Task #4762 — completion note from the served-purpose probe. */
  retiredNote?: string;
}


export interface ProdActionLastRunSummary {
  outcomeState: "applied" | "not-needed" | "error" | "blocked";
  detail: string | null;
  appliedAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
}


export interface ProdActionCompletedRow extends ProdActionStatusRow {
  lastRun: ProdActionLastRunSummary | null;
}


export interface ProdActionStatusesResult {
  /** All actions (backward-compat for any consumer still reading `actions`). */
  actions: ProdActionStatusRow[];
  /**
   * Actions needing operator attention: current `status.state` is
   * `pending`, `error`, or `blocked` (Task #2111 — reconnect-required).
   * Task #4054 — EXCLUDES auto-managed rows (healthy continuous
   * maintenance with routine pending work); the panel badge counts this
   * array, so it reaches zero on a normal day.
   */
  active: ProdActionStatusRow[];
  /**
   * Task #4054 — healthy always-on maintenance: `continuous` actions whose
   * status is `pending` while their draining loop (self-heal enrollment or
   * an external scheduler probed via `loopHealth`) is verifiably healthy.
   * Surfaced in a calm section, not counted by the needs-attention badge.
   */
  autoManaged: ProdActionStatusRow[];
  /** Actions whose current `status.state` is `applied` or `not-needed`. */
  completed: ProdActionCompletedRow[];
  /**
   * Task #2086 — whether the self-heal auto-healer master switch is ON.
   * The per-action durable readout lives on each row's `selfHeal` field.
   */
  selfHealEnabled: boolean;
  /**
   * Task #2095 — tick-level summary of the most recent self-heal pass
   * (when it ran + aggregate applied / not-needed / error counts), or
   * null when the auto-healer has never run. Lets the panel show
   * operators what the last pass did, not just the per-action rows.
   */
  selfHealLastRun: SelfHealLastRunSummary | null;
  /**
   * Task #2198 — classify-then-surface signal for the self-heal last-run
   * readout. `ok` (a readable summary), `never_run` (the normal fresh-deploy
   * state), or `unreadable` (a persisted-value parse/read failure — a real
   * persistence bug rather than "never ran"). `selfHealLastRunError` carries
   * the plain-English reason only when status is `unreadable`.
   */
  selfHealLastRunStatus: "ok" | "never_run" | "unreadable";
  selfHealLastRunError?: string;
  /**
   * Task #2173 — current persistent-failure alert tuning so the CEO panel
   * can show + adjust the trip point without touching raw settings.
   * `selfHealFailureAlertThreshold` is the normalized consecutive-error
   * count (1..50) that fires one alert; `selfHealFailureAlertEnabled`
   * tells the operator whether that alert is currently armed.
   */
  selfHealFailureAlertThreshold: number;
  selfHealFailureAlertEnabled: boolean;
}


/**
 * Task #2123 — classify a thrown error as an integration "needs reconnect"
 * (auth / not-connected / unauthorized) failure for SEMrush, Zoom, or
 * Google Ads, mirroring the Front reconnect-required reclassification from
 * Task #2111. When a prod-action throws *purely* because one of these
 * integration logins is missing, expired, or unauthorized, the panel should
 * show the calm amber "needs reconnect" (blocked) outcome naming the
 * integration — not a red error.
 *
 * Returns null for anything that is NOT one of these three integrations'
 * auth failures, so genuine bugs (DB errors, logic failures, transient
 * network/rate-limit errors) still surface red.
 *
 * Detection is duck-typed on the thrown error's own shape (error-class
 * `name`, the tagged `errorCategory` / `kind` / `terminal` fields each
 * service sets, and the integration-specific "not connected" / breaker
 * messages each service throws) so this helper needs no imports from the
 * three integration modules and cannot create an import cycle.
 */
export function classifyIntegrationAuthBlocked(
  err: unknown,
): { integration: string; detail: string } | null {
  if (err == null) return null;
  const e = err as any;
  const name = typeof e.name === "string" ? e.name : "";
  const message =
    typeof e.message === "string" && e.message ? e.message : String(err);

  // SEMrush — SemrushAuthMissingError carries name +
  // errorCategory="auth_config"; the SEMrush auth-breaker re-throws the same
  // class, whose message is "Semrush auth breaker open (...)".
  if (
    name === "SemrushAuthMissingError" ||
    e.errorCategory === "auth_config" ||
    /\bSemrush\b[^]*\b(not connected|auth breaker open|re-?authorize)\b/i.test(
      message,
    )
  ) {
    return { integration: "SEMrush", detail: message };
  }

  // Zoom — ZoomPermanentError (kind "auth"/"scope", thrown by the auth /
  // scope gate), a *terminal* ZoomRefreshError, and the "Zoom not connected"
  // guard. Non-terminal (transient) refresh failures intentionally stay red.
  if (
    name === "ZoomPermanentError" ||
    (name === "ZoomRefreshError" && e.terminal === true) ||
    /\bZoom\b[^]*\b(not connected|auth gate engaged|scope gate engaged)\b/i.test(
      message,
    )
  ) {
    return { integration: "Zoom", detail: message };
  }

  // Google Ads — the unified env-credential model (Task #4008):
  // getValidAccessToken throws "Google Ads not connected — the GOOGLE_ADS_*
  // env secrets are incomplete (…)" or "Google Ads credential rejected by
  // Google: …". Operator-recoverable = rotate the secret trio + restart.
  if (
    /\bGoogle Ads\b[^]*\b(not connected|credential)\b/i.test(
      message,
    )
  ) {
    return { integration: "Google Ads", detail: message };
  }

  return null;
}


function toLastRunSummary(
  run: ProdActionRunWithActor | undefined,
  fallbackStatus: ProdActionStatus,
): ProdActionLastRunSummary | null {
  if (run) {
    return {
      outcomeState: run.outcomeState as
        | "applied"
        | "not-needed"
        | "error"
        | "blocked",
      detail: run.detail,
      appliedAt: new Date(run.appliedAt).toISOString(),
      actorUserId: run.actorUserId,
      actorName: run.actorName,
      actorEmail: run.actorEmail,
    };
  }
  // Action has never been run via the panel — fall back to live status
  // so the History row still has *some* context. No actor / no
  // appliedAt because nothing was actually recorded.
  if (fallbackStatus.state === "applied" || fallbackStatus.state === "not-needed") {
    return {
      outcomeState: fallbackStatus.state,
      detail: fallbackStatus.detail,
      appliedAt: new Date(0).toISOString(),
      actorUserId: null,
      actorName: null,
      actorEmail: null,
    };
  }
  return null;
}


/**
 * Task #4762 — shared self-heal enrollment health predicate, split out of
 * evaluateContinuousLoopHealth so converging enrolled actions (whose
 * pending rows a healthy scheduler WILL press) apply exactly the same
 * rules: master switch ON, and no persistent failure streak at/over the
 * alert threshold. `nextEligibleAt` is surfaced when known so the calm
 * bucket can say "auto-applies by ~time" instead of a vague promise.
 */
export function evaluateSelfHealEnrollmentHealth(
  action: ProdAction,
  selfHealReadout: {
    enabled: boolean;
    actions: Record<string, SelfHealActionReadout>;
  },
  failureAlertThreshold: number,
): { healthy: boolean; detail: string; nextEligibleAt?: string } {
  if (!action.selfHeal) {
    return { healthy: false, detail: "Not enrolled in self-heal." };
  }
  if (!selfHealReadout.enabled) {
    return {
      healthy: false,
      detail:
        "Self-heal master switch is OFF — nothing drains this action automatically.",
    };
  }
  const readout = selfHealReadout.actions[action.id];
  if (!readout) {
    // Newly enrolled action the scheduler has not reached yet — the
    // loop is armed (master ON), so treat as healthy rather than
    // flapping the badge for the first tick after a deploy.
    return {
      healthy: true,
      detail:
        "Self-heal is ON; first automatic run for this action has not happened yet.",
    };
  }
  const failures = readout.consecutiveFailures ?? 0;
  if (failures >= Math.max(1, failureAlertThreshold)) {
    return {
      healthy: false,
      detail: `Self-heal loop is failing for this action (${failures} consecutive error(s)).`,
    };
  }
  return {
    healthy: true,
    detail: `Self-heal drains this automatically (last automatic run: ${
      readout.lastRunAt ?? "not yet"
    }, outcome: ${readout.lastOutcome ?? "n/a"}).`,
    ...(readout.nextEligibleAt ? { nextEligibleAt: readout.nextEligibleAt } : {}),
  };
}

/**
 * Task #4054 — evaluate whether a `continuous` action's draining loop is
 * verifiably healthy right now. Self-heal-enrolled actions derive health
 * from the durable self-heal readout (master switch ON + no persistent
 * failure streak); actions drained by an external scheduler run their own
 * `loopHealth` probe. Never throws — a probe failure reports unhealthy so
 * the row falls back to needing attention (fail toward visibility).
 */
export async function evaluateContinuousLoopHealth(
  action: ProdAction,
  selfHealReadout: {
    enabled: boolean;
    actions: Record<string, SelfHealActionReadout>;
  },
  failureAlertThreshold: number,
): Promise<{ healthy: boolean; detail: string }> {
  const conv = action.convergence;
  if (conv.kind !== "continuous") {
    return { healthy: false, detail: "Not a continuous action." };
  }
  if (conv.loopHealth) {
    try {
      const probe = await conv.loopHealth();
      return {
        healthy: probe.healthy,
        detail:
          probe.detail ??
          (probe.healthy
            ? `${conv.loop} is healthy.`
            : `${conv.loop} is not healthy.`),
      };
    } catch (err: any) {
      return {
        healthy: false,
        detail: `Loop-health probe for ${conv.loop} failed: ${err?.message ?? String(err)}`,
      };
    }
  }
  if (action.selfHeal) {
    const health = evaluateSelfHealEnrollmentHealth(
      action,
      selfHealReadout,
      failureAlertThreshold,
    );
    return { healthy: health.healthy, detail: health.detail };
  }
  // assertProdActionConvergenceInvariants() makes this unreachable, but
  // fail toward visibility if it ever regresses.
  return {
    healthy: false,
    detail:
      "Continuous action has neither self-heal enrollment nor a loop-health probe.",
  };
}

export async function getProdActionStatuses(): Promise<ProdActionStatusesResult> {
  return runWithWorkerDb(() =>
    withDbAttribution("maintenance:prod-actions-status", async () => {
      // Task #2086 — durable self-heal readout (master switch + per-action
      // last run / outcome / rows affected) so the panel can show what the
      // auto-healer did for each eligible action.
      const selfHealReadout = await getProdActionSelfHealReadout().catch(
        () => ({
          enabled: false,
          ranAt: null,
          lastRun: null as SelfHealLastRunSummary | null,
          // A thrown readout build is itself an unknown/error state, not a
          // confirmed "never ran" — classify it as unreadable.
          lastRunStatus: "unreadable" as const,
          lastRunError: "self-heal readout build failed",
          actions: {} as Record<string, SelfHealActionReadout>,
        }),
      );
      // Task #2173 — current persistent-failure alert tuning for the panel
      // (the trip point the CEO can adjust + whether the alert is armed).
      // Best-effort: a settings-read blip falls back to the safe defaults
      // rather than failing the whole status surface.
      const [selfHealFailureAlertThreshold, selfHealFailureAlertEnabled] =
        await Promise.all([
          getFailureAlertThreshold().catch(
            () => DEFAULT_FAILURE_ALERT_THRESHOLD,
          ),
          getFailureAlertEnabled().catch(() => false),
        ]);
      const all: ProdActionStatusRow[] = [];
      for (const action of PROD_ACTIONS) {
        let status: ProdActionStatus;
        try {
          status = await action.status();
        } catch (err: any) {
          // Task #2123 — a status() that threw purely because SEMrush /
          // Zoom / Google Ads is disconnected is operator-recoverable
          // (reconnect), not a bug. Surface it amber ("needs reconnect")
          // naming the integration, mirroring Front's #2111 reclassification.
          const blocked = classifyIntegrationAuthBlocked(err);
          status = blocked
            ? {
                state: "blocked",
                integration: blocked.integration,
                detail: blocked.detail,
              }
            : { state: "error", detail: err?.message ?? String(err) };
        }
        const selfHealEligible = action.selfHeal != null;
        // Task #4054 — continuous actions with a healthy draining loop
        // report their routine pending work as auto-managed maintenance.
        // Only `pending` qualifies: error/blocked always need attention.
        let autoManaged = false;
        let autoManagedDetail: string | undefined;
        if (status.state === "pending" && status.working === true) {
          // Task #4762 — the action's own background drain is observably
          // progressing right now (in-process drain loop / fanned-out queue
          // chain). That is direct evidence of drainage — calm working row
          // regardless of convergence class; the status detail carries the
          // live "N of M" progress.
          autoManaged = true;
          autoManagedDetail =
            "Background drain actively working — this row completes on its own; no operator action needed.";
        } else if (
          action.convergence.kind === "continuous" &&
          status.state === "pending"
        ) {
          const health = await evaluateContinuousLoopHealth(
            action,
            selfHealReadout,
            selfHealFailureAlertThreshold,
          );
          autoManaged = health.healthy;
          autoManagedDetail = health.detail;
        } else if (
          action.convergence.kind === "converging" &&
          action.selfHeal != null &&
          status.state === "pending"
        ) {
          // Task #4762 — converging actions enrolled in self-heal: while
          // the scheduler is ON and not failure-streaking on this action,
          // a healthy upcoming pass WILL press it — scheduled auto-applied
          // work, not operator work. Master OFF / failure streaks fall
          // through amber (fail toward visibility), and error/blocked
          // states never reach this branch.
          const health = evaluateSelfHealEnrollmentHealth(
            action,
            selfHealReadout,
            selfHealFailureAlertThreshold,
          );
          if (health.healthy) {
            autoManaged = true;
            autoManagedDetail = health.nextEligibleAt
              ? `Enrolled in self-heal — auto-applies by ~${health.nextEligibleAt} (next eligible pass).`
              : "Enrolled in self-heal — auto-applies on an upcoming pass.";
          } else {
            autoManagedDetail = health.detail;
          }
        }
        // Task #4762 — served-purpose probe: a lever whose target state is
        // fully reached retires to History. Never throws the status build —
        // a probe failure keeps the lever visible (fail toward visibility).
        let retired = false;
        let retiredNote: string | undefined;
        if (action.servedPurpose) {
          try {
            const sp = await action.servedPurpose();
            if (sp.served) {
              retired = true;
              retiredNote = sp.note;
            }
          } catch {
            retired = false;
          }
        }
        all.push({
          id: action.id,
          title: action.title,
          description: action.description,
          change: action.change,
          status,
          selfHealEligible,
          selfHeal: selfHealEligible
            ? selfHealReadout.actions[action.id] ?? null
            : null,
          manualLever: action.manualLever === true,
          ...(action.destructiveConfirmation
            ? {
                destructiveConfirmation: {
                  phrase: action.destructiveConfirmation.phrase,
                  warning: action.destructiveConfirmation.warning,
                },
              }
            : {}),
          convergence:
            action.convergence.kind === "continuous"
              ? { kind: "continuous", loop: action.convergence.loop }
              : { kind: "converging" },
          autoManaged,
          ...(autoManagedDetail ? { autoManagedDetail } : {}),
          ...(action.humanGate
            ? { humanGate: { reason: action.humanGate.reason } }
            : {}),
          ...(retired ? { retired: true as const } : {}),
          ...(retiredNote ? { retiredNote } : {}),
        });
      }
      const active = all.filter(
        (a) =>
          (a.status.state === "pending" ||
            a.status.state === "error" ||
            // Task #2111 — reconnect-required actions need operator
            // attention (re-login), so they belong with the active rows
            // (rendered amber, not red) rather than disappearing.
            a.status.state === "blocked") &&
          // Task #4054 — healthy continuous maintenance is auto-managed:
          // it drains on its own loop, so it does not count toward the
          // needs-attention badge.
          !a.autoManaged,
      );
      const autoManagedRows = all.filter((a) => a.autoManaged);
      const completedRaw = all.filter(
        (a) => a.status.state === "applied" || a.status.state === "not-needed",
      );
      const lastRuns = await getLastProdActionRunsForActions(
        completedRaw.map((a) => a.id),
      );
      const completed: ProdActionCompletedRow[] = completedRaw.map((a) => ({
        ...a,
        lastRun: toLastRunSummary(lastRuns.get(a.id), a.status),
      }));
      // Sort History most-recently-completed first; fallback rows with
      // epoch-zero appliedAt sort to the bottom.
      completed.sort((a, b) => {
        const at = a.lastRun?.appliedAt ?? "";
        const bt = b.lastRun?.appliedAt ?? "";
        return bt.localeCompare(at);
      });
      return {
        actions: all,
        active,
        autoManaged: autoManagedRows,
        completed,
        selfHealEnabled: selfHealReadout.enabled,
        selfHealLastRun: selfHealReadout.lastRun,
        selfHealLastRunStatus: selfHealReadout.lastRunStatus,
        ...(selfHealReadout.lastRunError
          ? { selfHealLastRunError: selfHealReadout.lastRunError }
          : {}),
        selfHealFailureAlertThreshold,
        selfHealFailureAlertEnabled,
      };
    }),
  );
}


export interface ProdActionApplyResult {
  id: string;
  title: string;
  description: string;
  change: string;
  outcome: ProdActionOutcome;
  appliedAt: string;
}


/**
 * Task #4019 — shared per-action apply executor used by both the
 * Apply-all pass and the single-action manual-lever endpoint, so the
 * classification/audit/result contract cannot drift between the two.
 *
 * With `viaApplyAll: true`, manual levers (`ProdAction.manualLever`) are
 * NEVER executed: the pass records a synthetic not-needed outcome (still
 * audited — every press writes one row per action, keeping the audit
 * contract) and the lever's dedicated endpoint stays the only way to
 * fire it.
 */
async function resolveProdActionOutcome(
  action: ProdAction,
  actorId: string | null,
  opts: { viaApplyAll?: boolean; confirmation?: string } = {},
): Promise<ProdActionOutcome> {
  let outcome: ProdActionOutcome;
  if (opts.viaApplyAll === true && action.manualLever === true) {
    outcome = {
      state: "not-needed",
      detail:
        "Manual lever — the Apply-all pass never fires it. Use its dedicated button in the panel's Manual levers section.",
    };
  } else {
    try {
      outcome = await action.apply(actorId, {
        confirmation: opts.confirmation,
      });
    } catch (err: any) {
      // Task #2123 — same reclassification as the status() path: an
      // apply() that threw only because SEMrush / Zoom / Google Ads is
      // disconnected reports amber ("needs reconnect"), naming the
      // integration, instead of a red error.
      const blocked = classifyIntegrationAuthBlocked(err);
      outcome = blocked
        ? {
            state: "blocked",
            integration: blocked.integration,
            detail: blocked.detail,
          }
        : { state: "error", detail: err?.message ?? String(err) };
    }
  }
  return outcome;
}

async function recordAndBuildProdActionApplyResult(
  action: ProdAction,
  actorId: string | null,
  outcome: ProdActionOutcome,
): Promise<ProdActionApplyResult> {
  const appliedAt = new Date();
  // Task #1806 — write one audit row per action per apply. Audit
  // write is best-effort: a failure to persist the audit must NOT
  // mask the operator's apply result (they still see outcome +
  // detail). The error is logged and the caller proceeds.
  try {
    const rowsAffected =
      outcome.state === "applied" && "rowsAffected" in outcome
        ? outcome.rowsAffected ?? null
        : null;
    await recordProdActionRun({
      actionId: action.id,
      actionTitle: action.title,
      actorUserId: actorId ?? null,
      outcomeState: outcome.state,
      detail: outcome.detail ?? null,
      rowsAffected,
      errorMessage: outcome.state === "error" ? outcome.detail : null,
    });
  } catch (auditErr: any) {
    console.error(
      "[prod-actions] audit insert failed for",
      action.id,
      "—",
      auditErr?.message ?? auditErr,
    );
  }
  return {
    id: action.id,
    title: action.title,
    description: action.description,
    change: action.change,
    outcome,
    appliedAt: appliedAt.toISOString(),
  };
}

async function settleProdActionApply(
  action: ProdAction,
  actorId: string | null,
  opts: { viaApplyAll?: boolean; confirmation?: string } = {},
): Promise<ProdActionApplyResult> {
  const outcome = await resolveProdActionOutcome(action, actorId, opts);
  return recordAndBuildProdActionApplyResult(action, actorId, outcome);
}

export async function applyAllProdActions(
  actorId: string | null,
): Promise<ProdActionApplyResult[]> {
  return runWithWorkerDb(() =>
    withDbAttribution("maintenance:prod-actions-apply", async () => {
      const results: ProdActionApplyResult[] = [];
      for (const action of PROD_ACTIONS) {
        results.push(
          await settleProdActionApply(action, actorId, { viaApplyAll: true }),
        );
      }
      return results;
    }),
  );
}


export type ApplyOneProdActionResult =
  | { kind: "not_found" }
  | { kind: "not_manual_lever" }
  | { kind: "applied"; result: ProdActionApplyResult };

// Direct manual levers do not all use startBackgroundDrain (some are short,
// synchronous control-plane changes). Collapse genuinely concurrent calls by
// action id so one process cannot execute the same direct lever twice while
// still allowing different levers to run independently.
const manualLeverApplies = new Map<string, Promise<ProdActionApplyResult>>();

function resetManualLeverAppliesForTest(): void {
  manualLeverApplies.clear();
}
export const __resetManualLeverAppliesForCrossInstanceTest =
  resetManualLeverAppliesForTest;
registerModuleStateResetForTest(
  "prodActions.engine.manualLeverApplies",
  resetManualLeverAppliesForTest,
);


/**
 * Task #4019 — single-action apply, restricted to manual levers. Normal
 * actions stay Apply-all-only (the panel's one-and-done lane); levers are
 * excluded from Apply-all and fired individually here, so a deliberate
 * operator choice (e.g. the Zoom S2S emergency rollback) can never ride
 * along with a routine Apply-all press.
 */
export async function applyOneProdAction(
  actionId: string,
  actorId: string | null,
  confirmation?: string,
): Promise<ApplyOneProdActionResult> {
  const action = PROD_ACTIONS.find((a) => a.id === actionId);
  if (!action) return { kind: "not_found" };
  if (action.manualLever !== true) return { kind: "not_manual_lever" };

  const existing = manualLeverApplies.get(action.id);
  if (existing) {
    return { kind: "applied", result: await existing };
  }

  const operation = runWithWorkerDb(async () => {
    const lock = await acquireProdActionManualLock(action.id);
    if (!lock) {
      return {
        id: action.id,
        title: action.title,
        description: action.description,
        change: action.change,
        outcome: {
          state: "blocked" as const,
          detail:
            "This manual lever is already firing on another app instance. " +
            "No duplicate action was started; refresh History after the active request settles.",
        },
        appliedAt: new Date().toISOString(),
      };
    }
    try {
      const outcome = await withDbAttribution("maintenance:prod-actions-apply", () =>
        resolveProdActionOutcome(action, actorId, { confirmation }),
      );
      // Release the pinned advisory-lock connection before the audit insert.
      // The action side effect is complete, so another press cannot overlap
      // it; freeing this connection prevents concurrent distinct levers from
      // consuming the pool and starving their own audit writes.
      await lock.release();
      return await withDbAttribution("maintenance:prod-actions-apply", () =>
        recordAndBuildProdActionApplyResult(action, actorId, outcome),
      );
    } finally {
      await lock.release();
    }
  });
  manualLeverApplies.set(action.id, operation);
  try {
    return { kind: "applied", result: await operation };
  } finally {
    if (manualLeverApplies.get(action.id) === operation) {
      manualLeverApplies.delete(action.id);
    }
  }
}
