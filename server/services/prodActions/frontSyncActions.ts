// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): Front sync pipeline integrity — reconciliation sweeps, auto-closure ticks, webhook dead-letter replay, and mirror-gap reconciliation.
 *
 * Split verbatim out of the monolithic server/services/prodActionsRegistry.ts.
 * Every action definition, helper, and comment below is a byte-for-byte
 * relocation (the only mechanical changes: `export ` added where the
 * composition root or a sibling module now imports a symbol, and inline
 * PROD_ACTIONS array entries hoisted into named consts). Do NOT add new
 * behavior here without the usual prod-action review gates; registration
 * order lives in ./composition.ts, not in this file.
 */

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution, withDbHoldLabel } from "../../db";
import { bindArrayParam } from "../../utils/sqlArray";
import { storage } from "../../storage";
import { normalizeClientEmailDomains } from "@shared/models/clients";
import { VENDOR_PLATFORM_DOMAINS, isVendorPlatformDomain } from "../seedingTrustPolicy";
import { extractDomain, isCompanyDomain, isPublicEmailDomain } from "../companyIdentity";
import { invalidateHardMatchIndexes } from "../frontHardMatch";
import { stampThreadWideClientAttribution } from "../frontThreadAttribution";
import {
  startBackgroundDrain,
  getDrainState,
  formatDrainProgress,
  isDrainRunning,
  type DrainChunkResult,
} from "../prodActionBackgroundDrain";
import { getLastSuccessfulProdActionRun } from "../../storage/prodActionRuns";
import { MAX_BULK_REPLAY, enqueueJob } from "../workScheduler";
import { type ProdAction, type ProdActionDomain } from "./kernel";
import { systemSettingAction } from "./helpers";


// ─── Task #1825: trigger a one-shot Front reconciliation sweep ───────
//
// One-click operator surface that enqueues a single
// `front_reconciliation` job immediately, independent of the 15-minute
// scheduler in `frontReconciliationScheduler.ts`. Used to kick the
// auto-heal path when a live-webhook outage has been suspected
// (e.g. May 18 → May 21 silent gap) without waiting for the next
// scheduler tick. Idempotent: dedupe key is per-minute so spamming
// the button only ever leaves one pending row.
export const triggerFrontReconciliationSweepAction: ProdAction = {
  id: "trigger_front_reconciliation_sweep",
  title: "Trigger Front reconciliation sweep now",
  description:
    "Enqueues a single front_reconciliation job immediately so the Front REST-API auto-heal sweep runs without waiting for the 15-minute scheduler tick. Honors the same safety gates as the scheduler (PERF.FRONT_RECONCILIATION_ENABLED, queue-drain pause, KILL_SWITCH_NON_CRITICAL_SWEEPS, Front access token present). Per-minute dedupe key so repeat presses don't pile up duplicate rows.",
  change: "Enqueue one front_reconciliation work_queue row (workload_class=ingestion, priority=250).",
  // Task #4054 — this is a manual nudge for the always-on 15-minute
  // reconciliation scheduler: gates reopen after every completed sweep, so
  // "pending" here means "the button could fire", not "work is owed". While
  // the scheduled loop is armed, the badge treats that pending as
  // auto-managed maintenance.
  convergence: {
    kind: "continuous",
    loop: "front_reconciliation scheduler (15-min tick)",
    async loopHealth() {
      const { evaluateFrontReconciliationGates } = await import(
        "../frontReconciliationScheduler"
      );
      // Evaluate the SCHEDULED path (not "manual"): the loop is healthy
      // only if the periodic tick itself would run — including the
      // scheduler-enable setting the manual button intentionally skips.
      const gate = await evaluateFrontReconciliationGates("scheduled");
      if (gate.open) {
        return {
          healthy: true,
          detail: "15-min reconciliation scheduler is armed (all gates open).",
        };
      }
      if (gate.reason === "inflight_job_present") {
        return {
          healthy: true,
          detail: "A reconciliation sweep is already queued/running.",
        };
      }
      return {
        healthy: false,
        detail: `Reconciliation scheduler gate closed: ${gate.reason}.`,
      };
    },
  },
  async status() {
    // Post-press cooldown: this is a "trigger" / "kick" action with no
    // durable state — once the enqueued job runs, gates reopen and the
    // panel would perpetually show "1 pending" after every Apply-all.
    // If a successful manual press happened in the last 2 minutes
    // (covers the 60s dedupe bucket + a slack window), report
    // not-needed with the timestamp so the operator can see exactly
    // when it last fired.
    const lastRun = await getLastSuccessfulProdActionRun(
      "trigger_front_reconciliation_sweep",
    );
    if (lastRun?.appliedAt) {
      const ageMs = Date.now() - new Date(lastRun.appliedAt).getTime();
      if (ageMs >= 0 && ageMs < 2 * 60_000) {
        return {
          state: "not-needed",
          detail: `Recently triggered ${Math.floor(ageMs / 1000)}s ago — sweep is in flight or just completed. This action will become available again automatically once the 2-minute cooldown elapses.`,
        };
      }
    }
    const { evaluateFrontReconciliationGates } = await import(
      "../frontReconciliationScheduler"
    );
    // Evaluate every gate the apply() path would hit, so the operator
    // sees an accurate reason in the panel before pressing the button.
    // Pass "manual" so the CEO override path does NOT report
    // `scheduler_setting_disabled` — the panel button is intentionally
    // independent of the 15-min scheduler enable knob (the operator can
    // force a one-off sweep even when the periodic cadence is off).
    const gate = await evaluateFrontReconciliationGates("manual");
    if (!gate.open) {
      if (gate.reason === "perf_flag_disabled") {
        return {
          state: "not-needed",
          detail: "FRONT_RECONCILIATION_ENABLED is false; flip it on before triggering.",
        };
      }
      if (gate.reason === "queue_paused") {
        return {
          state: "not-needed",
          detail:
            "front_reconciliation queue is paused via queue_drain_state — unpause it first.",
        };
      }
      if (gate.reason === "non_critical_sweeps_killed") {
        return {
          state: "not-needed",
          detail: "KILL_SWITCH_NON_CRITICAL_SWEEPS is on — flip it off first.",
        };
      }
      if (gate.reason === "front_not_connected") {
        return {
          state: "blocked",
          integration: "Front",
          detail:
            "Front login is not connected — reconnect Front in the Integrations Hub, then re-run.",
        };
      }
      if (gate.reason === "scheduler_setting_disabled") {
        return {
          state: "not-needed",
          detail:
            "front_reconciliation_scheduler_enabled is false — flip it on first.",
        };
      }
      if (gate.reason === "inflight_job_present") {
        return {
          state: "not-needed",
          detail:
            "A front_reconciliation job is already pending/processing — no need to enqueue another.",
        };
      }
      return {
        state: "error",
        detail: gate.detail ?? "Gate evaluation failed.",
      };
    }
    return {
      state: "pending",
      detail: "Will enqueue one front_reconciliation job.",
    };
  },
  async apply() {
    const { enqueueManualFrontReconciliation } = await import(
      "../frontReconciliationScheduler"
    );
    // Manual path uses a per-minute dedupe bucket so back-to-back
    // operator presses coalesce, but a genuine "kick" 60+ seconds later
    // still goes through — independent of the longer (15-min default)
    // scheduler cadence.
    const outcome = await enqueueManualFrontReconciliation();
    if (outcome.enqueued) {
      return {
        state: "applied",
        detail: `Enqueued front_reconciliation job (bucket ${outcome.bucket}). Watch /admin/integrations/front and front_sync_emails for new rows within ~1 min.`,
      };
    }
    if (outcome.reason === "queue_paused") {
      return {
        state: "not-needed",
        detail: "front_reconciliation queue is paused via queue_drain_state — unpause it first.",
      };
    }
    if (outcome.reason === "non_critical_sweeps_killed") {
      return {
        state: "not-needed",
        detail: "KILL_SWITCH_NON_CRITICAL_SWEEPS is on — flip it off first.",
      };
    }
    if (outcome.reason === "front_not_connected") {
      return {
        state: "blocked",
        integration: "Front",
        detail: "Front login is not connected — reconnect Front in the Integrations Hub, then re-run.",
      };
    }
    if (outcome.reason === "perf_flag_disabled") {
      return {
        state: "not-needed",
        detail: "FRONT_RECONCILIATION_ENABLED env var is false.",
      };
    }
    if (outcome.reason === "scheduler_setting_disabled") {
      return {
        state: "not-needed",
        detail: "front_reconciliation_scheduler_enabled is false — flip it on first.",
      };
    }
    if (outcome.reason === "inflight_job_present") {
      return {
        state: "not-needed",
        detail: "A front_reconciliation job is already pending/processing — no need to enqueue another.",
      };
    }
    return {
      state: "error",
      detail: `Enqueue failed: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`,
    };
  },
};


// ─── Trigger Front auto-closure tick now ─────────────────────────────
//
// One-click operator surface that enqueues a single
// `front_auto_closure_tick` job immediately, independent of the ~60s
// scheduler in `frontAutoClosureScheduler.ts`. Used to kick the
// self-heal loop without waiting for the next scheduler tick — useful
// right after flipping the warp settings (`enable_front_gap_drain_warp`)
// to confirm the loop fires and starts enqueuing
// `front_historical_backfill` jobs. Idempotent: per-30s dedupe bucket
// so spamming the button only ever leaves one pending row.
export const triggerFrontAutoClosureTickAction: ProdAction = {
  id: "trigger_front_auto_closure_tick",
  title: "Trigger Front auto-closure tick now",
  description:
    "Enqueues a single front_auto_closure_tick job immediately so the self-heal loop (runFrontAutoClosureTick) fires without waiting for the ~60s scheduler tick. Honors the same safety gates as the scheduler (FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED, queue-drain pause, KILL_SWITCH_NON_CRITICAL_SWEEPS, Front access token present). Per-30s dedupe bucket so repeat presses don't pile up duplicate rows.",
  change: "Enqueue one front_auto_closure_tick work_queue row (workload_class=maintenance, priority=400).",
  // Task #4054 — manual nudge for the always-on ~60s auto-closure
  // scheduler; gates reopen after each tick, so a healthy scheduled loop
  // makes this pending state auto-managed maintenance.
  convergence: {
    kind: "continuous",
    loop: "front_auto_closure scheduler (~60s tick)",
    async loopHealth() {
      const { evaluateFrontAutoClosureGates } = await import(
        "../frontAutoClosureScheduler"
      );
      // Scheduled path (not "manual") — the loop is only healthy if the
      // periodic tick itself would run, including the scheduler-enable
      // setting the manual button intentionally skips.
      const gate = await evaluateFrontAutoClosureGates("scheduled");
      if (gate.open) {
        return {
          healthy: true,
          detail: "Auto-closure scheduler is armed (all gates open).",
        };
      }
      if (gate.reason === "inflight_job_present") {
        return {
          healthy: true,
          detail: "An auto-closure tick is already queued/running.",
        };
      }
      return {
        healthy: false,
        detail: `Auto-closure scheduler gate closed: ${gate.reason}.`,
      };
    },
  },
  async status() {
    const lastRun = await getLastSuccessfulProdActionRun(
      "trigger_front_auto_closure_tick",
    );
    if (lastRun?.appliedAt) {
      const ageMs = Date.now() - new Date(lastRun.appliedAt).getTime();
      if (ageMs >= 0 && ageMs < 90_000) {
        return {
          state: "not-needed",
          detail: `Recently triggered ${Math.floor(ageMs / 1000)}s ago — tick is in flight or just completed.`,
        };
      }
    }
    const { evaluateFrontAutoClosureGates } = await import(
      "../frontAutoClosureScheduler"
    );
    const gate = await evaluateFrontAutoClosureGates("manual");
    if (!gate.open) {
      if (gate.reason === "perf_flag_disabled") {
        return {
          state: "not-needed",
          detail: "FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED is false; flip it on before triggering.",
        };
      }
      if (gate.reason === "queue_paused") {
        return {
          state: "not-needed",
          detail:
            "front_auto_closure_tick queue is paused via queue_drain_state — unpause it first.",
        };
      }
      if (gate.reason === "non_critical_sweeps_killed") {
        return {
          state: "not-needed",
          detail: "KILL_SWITCH_NON_CRITICAL_SWEEPS is on — flip it off first.",
        };
      }
      if (gate.reason === "front_not_connected") {
        return {
          state: "blocked",
          integration: "Front",
          detail:
            "Front login is not connected — reconnect Front in the Integrations Hub, then re-run.",
        };
      }
      if (gate.reason === "inflight_job_present") {
        return {
          state: "not-needed",
          detail:
            "A front_auto_closure_tick job is already pending/processing — no need to enqueue another.",
        };
      }
      return {
        state: "error",
        detail: gate.detail ?? "Gate evaluation failed.",
      };
    }
    // Task #2499 — gates open means the auto-closure self-heal loop is enabled
    // and healthy, so it already fires a tick automatically on its ~60s
    // cadence: a manual nudge is never REQUIRED, it would only save the
    // operator a sub-minute wait. Settle to not-needed so the button does not
    // sit perpetually in the panel's attention bucket between scheduler ticks
    // (Task #2281 one-apply convergence). Apply still fires one on demand.
    return {
      state: "not-needed",
      detail:
        "The Front auto-closure self-heal loop is enabled and healthy — it fires a tick automatically about every 60 seconds, so triggering one by hand isn't required.",
    };
  },
  async apply() {
    const { enqueueManualFrontAutoClosureTick } = await import(
      "../frontAutoClosureScheduler"
    );
    const outcome = await enqueueManualFrontAutoClosureTick();
    if (outcome.enqueued) {
      return {
        state: "applied",
        detail: `Enqueued front_auto_closure_tick job (bucket ${outcome.bucket}). Watch /admin/integrations/front for new front_historical_backfill enqueues within ~30 s.`,
      };
    }
    if (outcome.reason === "queue_paused") {
      return {
        state: "not-needed",
        detail: "front_auto_closure_tick queue is paused via queue_drain_state — unpause it first.",
      };
    }
    if (outcome.reason === "non_critical_sweeps_killed") {
      return {
        state: "not-needed",
        detail: "KILL_SWITCH_NON_CRITICAL_SWEEPS is on — flip it off first.",
      };
    }
    if (outcome.reason === "front_not_connected") {
      return {
        state: "blocked",
        integration: "Front",
        detail: "Front login is not connected — reconnect Front in the Integrations Hub, then re-run.",
      };
    }
    if (outcome.reason === "perf_flag_disabled") {
      return {
        state: "not-needed",
        detail: "FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED env var is false.",
      };
    }
    if (outcome.reason === "inflight_job_present") {
      return {
        state: "not-needed",
        detail: "A front_auto_closure_tick job is already pending/processing.",
      };
    }
    return {
      state: "error",
      detail: `Enqueue failed: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`,
    };
  },
};


// ─── Task #1834: Replay front_webhook_apply dead-letter backlog ──────
//
// Operator-pressed counterpart to `scripts/replay-front-webhook-apply-
// dead-letter.ts`. Task #1831 restored the writer that populates
// `front_sync_emails`, but the pre-cutover rows still sitting in
// `pipeline_state='discovered'` from the original
// `e.toISOString is not a function` crash have to be drained by
// replaying the matching `dead_letter` rows in the `front_webhook_apply`
// queue. The CLI script does the same thing, but the CEO panel is the
// path that actually runs against the deployed prod DB (the script run
// from the workspace would hit the dev Helium DB).
//
// Each press replays at most `MAX_BULK_REPLAY` (500) rows via
// `bulkReplayDeadLetteredJobs({ queueName: "front_webhook_apply" })`.
// One-and-done (Task #1969): the press kicks off a background drain
// that loops `replayDeadLetteredJobsBatch` (cap=500/chunk) on the
// worker pool until no dead-letter rows remain, then writes the final
// tally to History. The underlying helper is idempotent — once a row
// is reset to `pending` it no longer matches the dead-letter filter,
// so concurrent presses cannot double-replay. Pending/processing/failed
// rows are never touched.
const REPLAY_FRONT_APPLY_QUEUE = "front_webhook_apply";


export const replayFrontWebhookApplyDeadLetterAction: ProdAction = {
  id: "replay_front_webhook_apply_dead_letter",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Replaying dead-letter rows re-runs work that already failed repeatedly — an operator confirms the underlying outage is fixed before re-driving the backlog.",
  },
  title: "Replay front_webhook_apply dead-letter backlog (Task #1834)",
  description:
    "Replays the entire dead-letter backlog on the `front_webhook_apply` queue so pre-cutover `pipeline_state='discovered'` rows from Task #1831's writer outage finally transition to `applied` and the Front Historical Recovery coverage report's 2026-02 → 2026-04 gap closes. One-and-done: a single press starts a background drain that loops `replayDeadLetteredJobsBatch` (cap=" +
    String(MAX_BULK_REPLAY) +
    " rows/chunk) on the worker pool until no dead-letter rows remain. Idempotent: each chunk resets matching `dead_letter` rows back to `pending` with `attempt_count=0` so the scheduler picks them up on the next tick, then the chunk filter no longer matches them. Only touches `status='dead_letter'` rows in the `front_webhook_apply` queue — pending/processing/failed rows are never modified.",
  change: `Background-drain bulk replay of dead-lettered ${REPLAY_FRONT_APPLY_QUEUE} jobs in ${MAX_BULK_REPLAY}-row chunks until none remain.`,
  async status() {
    if (isDrainRunning("replay_front_webhook_apply_dead_letter")) {
      const s = getDrainState("replay_front_webhook_apply_dead_letter")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const result = await withDbAttribution(
      "maintenance:prod-actions-front-apply-deadletter-count",
      () =>
        getDb().execute(sql`
          SELECT COUNT(*)::int AS n
          FROM work_queue
          WHERE queue_name = ${REPLAY_FRONT_APPLY_QUEUE}
            AND status = 'dead_letter'
        `),
    );
    const n = Number((result.rows as any[])[0]?.n ?? 0);
    if (n === 0) {
      return {
        state: "not-needed",
        detail: "No dead-lettered front_webhook_apply rows remain.",
      };
    }
    return {
      state: "pending",
      detail: `${n} dead-lettered row(s); a single press will replay all of them via a background drain (${MAX_BULK_REPLAY} per chunk).`,
    };
  },
  async apply(actorId) {
    const { replayDeadLetteredJobsBatch } = await import("../workScheduler");
    const out = await startBackgroundDrain(
      {
        actionId: "replay_front_webhook_apply_dead_letter",
        actionTitle: "Replay front_webhook_apply dead-letter backlog",
        attributionLabel: "maintenance:prod-actions-front-apply-deadletter-replay",
        countPending: async () => {
          const r = await withDbAttribution(
            "maintenance:prod-actions-front-apply-deadletter-count",
            () => getDb().execute(sql`
              SELECT COUNT(*)::int AS n
              FROM work_queue
              WHERE queue_name = ${REPLAY_FRONT_APPLY_QUEUE}
                AND status = 'dead_letter'
            `),
          );
          return Number((r.rows as any[])[0]?.n ?? 0);
        },
        runChunk: async () => {
          const result = await replayDeadLetteredJobsBatch({
            queueName: REPLAY_FRONT_APPLY_QUEUE,
            operatorId: actorId ?? "prod-actions-panel",
            operatorUsername: actorId ?? "prod-actions-panel",
          });
          return {
            processed: result.replayedCount,
            perKey: { [REPLAY_FRONT_APPLY_QUEUE]: result.replayedCount },
          };
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #2089 — Drain the stuck `discovered` Front apply tail ───────
//
// Background: ~6,914 `front_sync_emails` rows have sat in
// pipeline_state='discovered' since 2026-04-14 — the inert residual of
// the 2026-04 apply-stall (epic #1641/#1803/#1834/#1836, absorbs
// #1921). These are NOT live failures: the live webhook normalize/apply
// stages, the dead-letter replay (`replay_front_webhook_apply_dead_letter`),
// and the Front recovery auto-closure ticks only ever re-touch rows that
// still have a pending/dead-letter apply job or a fresh normalize event.
// These rows have neither, so nothing advances them and they sit forever.
//
// `front_sync_emails` is the webhook-pipeline mirror / observability
// layer (see frontSyncEmailMirror.ts). A row's pipeline_state='applied'
// means "the apply stage recorded this conversation as ingested into
// raw_communication_records". So the correct resolution for each stuck
// row is a single deterministic reconcile:
//   • raw_communication_records already has a row for the Front
//     conversation id  → the conversation WAS applied; the mirror just
//     never recorded it (the row predates / lost its apply callback).
//     Reconcile the mirror FORWARD to 'applied' and backfill
//     ingested_record_id. This row was never inflating the apply gap
//     (it is already counted in raw_communication_records).
//   • no raw_communication_records row  → the conversation never
//     reached apply and has no remaining trigger that would re-drive it.
//     Terminally close the mirror to 'failed' with a documented reason
//     so it stops counting as inert `discovered` backlog and is instead
//     a recognised, documented terminal failure.
//
// We deliberately do NOT re-enqueue these onto `front_sync_reprocess`:
// that queue's worker updates the match/ingest layer (matchStatus,
// ingested_record_id) but never advances the mirror pipeline_state
// machine, so it cannot satisfy the "resolves to applied/failed"
// contract on its own and would leave the rows stuck in `discovered`.
//
// Safety / tenancy: runs entirely on the worker pool via
// startBackgroundDrain → runWithWorkerDb. Only writes the
// front_sync_emails mirror table — never raw_communication_records,
// clients, or any other authoritative entity. Each chunk is a short,
// indexed SELECT + at most two bulk UPDATEs, all well under the 10s
// DB-hold cap. A 24h staleness floor on state_changed_at protects any
// genuinely in-flight `discovered` row (live rows apply within seconds).
// Idempotent: the chunk filter only matches discovered rows older than
// 24h, so a resolved row never matches again.
const DRAIN_FRONT_DISCOVERED_APPLY_TAIL_ID =
  "drain_stuck_front_discovered_apply_tail";

const FRONT_DISCOVERED_APPLY_TAIL_BATCH = 500;

const FRONT_DISCOVERED_APPLY_TAIL_STALE_HOURS = 24;

const FRONT_DISCOVERED_APPLY_TAIL_FAIL_REASON =
  "[task-2089] discovered_apply_tail: no raw_communication_record — conversation never reached apply and has no remaining trigger; closed out as terminal residual of the 2026-04 apply-stall (epic #1641/#1803/#1834/#1836)";


async function countStuckDiscoveredApplyTail(): Promise<number> {
  const result = await withDbHoldLabel(
    "maintenance:prod-actions-front-discovered-apply-tail-count",
    () =>
      getDb().execute(sql`
        SELECT COUNT(*)::int AS n
        FROM front_sync_emails
        WHERE pipeline_state = 'discovered'
          AND COALESCE(state_changed_at, created_at)
              < NOW() - (${FRONT_DISCOVERED_APPLY_TAIL_STALE_HOURS} || ' hours')::interval
      `),
  );
  return Number((result.rows as any[])[0]?.n ?? 0);
}


async function drainStuckDiscoveredApplyTailChunk(): Promise<{
  processed: number;
  perKey: Record<string, number>;
}> {
  // 1. Claim a batch of stale `discovered` rows (short, indexed hold).
  const claimed = await withDbHoldLabel(
    "front_discovered_apply_tail:select",
    () =>
      getDb().execute(sql`
        SELECT id, conversation_id
        FROM front_sync_emails
        WHERE pipeline_state = 'discovered'
          AND COALESCE(state_changed_at, created_at)
              < NOW() - (${FRONT_DISCOVERED_APPLY_TAIL_STALE_HOURS} || ' hours')::interval
        ORDER BY COALESCE(state_changed_at, created_at) ASC
        LIMIT ${FRONT_DISCOVERED_APPLY_TAIL_BATCH}
      `),
  );
  const rows = claimed.rows as Array<{ id: string; conversation_id: string }>;
  if (rows.length === 0) return { processed: 0, perKey: {} };

  const convIds = rows.map((r) => r.conversation_id);

  // 2. Which of these conversations already have a raw_communication_record
  // (i.e. the apply DID happen) — short hold.
  const rawRowsResult = await withDbHoldLabel(
    "front_discovered_apply_tail:raw-lookup",
    () =>
      getDb().execute(sql`
        SELECT external_source_id, id
        FROM raw_communication_records
        WHERE source_type = 'front_email'
          AND external_source_id = ANY(${bindArrayParam(convIds, "text")})
      `),
  );
  const recordByConv = new Map<string, string>();
  for (const r of rawRowsResult.rows as Array<{
    external_source_id: string;
    id: string;
  }>) {
    if (!recordByConv.has(r.external_source_id)) {
      recordByConv.set(r.external_source_id, r.id);
    }
  }

  const appliedRows = rows.filter((r) => recordByConv.has(r.conversation_id));
  const failedIds = rows
    .filter((r) => !recordByConv.has(r.conversation_id))
    .map((r) => r.id);

  let movedApplied = 0;
  let movedFailed = 0;

  // 3a. Reconcile already-ingested rows FORWARD to 'applied', backfilling
  // ingested_record_id from the matched raw_communication_record. Single
  // bulk UPDATE ... FROM (VALUES …) so the hold stays short.
  if (appliedRows.length > 0) {
    const pairs = appliedRows.map(
      (r) => sql`(${r.id}, ${recordByConv.get(r.conversation_id)!})`,
    );
    const valuesSql = sql.join(pairs, sql`, `);
    const appliedResult = await withDbHoldLabel(
      "front_discovered_apply_tail:reconcile-applied",
      () =>
        getDb().execute(sql`
          UPDATE front_sync_emails AS f
          SET pipeline_state = 'applied',
              ingested_record_id = v.rid,
              processed_at = NOW(),
              state_changed_at = NOW(),
              pipeline_error = NULL
          FROM (VALUES ${valuesSql}) AS v(id, rid)
          WHERE f.id = v.id
            AND f.pipeline_state = 'discovered'
        `),
    );
    movedApplied = appliedResult.rowCount ?? appliedRows.length;
  }

  // 3b. Terminally close the never-applied rows to 'failed' with a
  // documented reason. Single bulk UPDATE.
  if (failedIds.length > 0) {
    const failedResult = await withDbHoldLabel(
      "front_discovered_apply_tail:close-terminal",
      () =>
        getDb().execute(sql`
          UPDATE front_sync_emails
          SET pipeline_state = 'failed',
              pipeline_error = ${FRONT_DISCOVERED_APPLY_TAIL_FAIL_REASON},
              pipeline_attempts = pipeline_attempts + 1,
              state_changed_at = NOW()
          WHERE id = ANY(${bindArrayParam(failedIds, "text")})
            AND pipeline_state = 'discovered'
        `),
    );
    movedFailed = failedResult.rowCount ?? failedIds.length;
  }

  return {
    processed: movedApplied + movedFailed,
    perKey: { reconciled_applied: movedApplied, closed_terminal: movedFailed },
  };
}


export const drainStuckFrontDiscoveredApplyTailAction: ProdAction = {
  id: DRAIN_FRONT_DISCOVERED_APPLY_TAIL_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Re-drives rows stuck pre-apply and closes out terminal residue — a fresh accumulation means the apply path is failing again, so an operator confirms the root cause is fixed before re-driving.",
  },
  title: "Drain stuck 'discovered' Front apply tail (Task #2089)",
  description:
    "Resolves the residual `front_sync_emails` rows stuck in pipeline_state='discovered' for more than 24h — the inert tail of the 2026-04 apply-stall (epic #1641/#1803/#1834/#1836, absorbs #1921) that no live trigger, dead-letter replay, or recovery tick re-touches. One-and-done: a single press starts a worker-pool background drain that resolves each stuck row to a terminal state in 500-row chunks. Per row it checks raw_communication_records by Front conversation id — if a record already exists the conversation WAS applied so the mirror is reconciled forward to 'applied' (ingested_record_id backfilled), otherwise the row is terminally closed to 'failed' with a documented reason. Idempotent: the chunk filter only matches discovered rows older than 24h, so a resolved row never matches again. Only writes the front_sync_emails mirror table — never raw_communication_records or any authoritative entity.",
  change:
    "Background-drain over front_sync_emails discovered>24h: reconcile to 'applied' when a raw_communication_record exists (backfilling ingested_record_id), else terminally mark 'failed' with the [task-2089] reason; 500-row chunks on the worker pool until none remain.",
  async status() {
    if (isDrainRunning(DRAIN_FRONT_DISCOVERED_APPLY_TAIL_ID)) {
      const s = getDrainState(DRAIN_FRONT_DISCOVERED_APPLY_TAIL_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const n = await withDbAttribution(
      "maintenance:prod-actions-front-discovered-apply-tail-status",
      () => countStuckDiscoveredApplyTail(),
    );
    if (n === 0) {
      return {
        state: "not-needed",
        detail: "No stuck 'discovered' Front apply-tail rows older than 24h remain.",
      };
    }
    return {
      state: "pending",
      detail: `${n} stuck 'discovered' row(s) older than 24h; a single press resolves all of them via a background drain (${FRONT_DISCOVERED_APPLY_TAIL_BATCH} per chunk).`,
    };
  },
  async apply(actorId) {
    const out = await startBackgroundDrain(
      {
        actionId: DRAIN_FRONT_DISCOVERED_APPLY_TAIL_ID,
        actionTitle: "Drain stuck 'discovered' Front apply tail",
        attributionLabel:
          "maintenance:prod-actions-front-discovered-apply-tail-drain",
        unit: "row(s)",
        countPending: () => countStuckDiscoveredApplyTail(),
        runChunk: () => drainStuckDiscoveredApplyTailChunk(),
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Task #2670 — reconcile Front emails with no mirror row ───────────
//
// One idempotent, breaker-aware CEO prod-action (worker pool) that closes
// the Front Console "Tracked > Matchable" gap: `front_email` rows in
// `raw_communication_records` whose Front conversation id
// (`external_thread_id`) has NO matching `front_sync_emails` mirror row.
// Such a record is tracked (it exists in the unified comms log) but is
// invisible to the matching surface (which only ever reads the mirror
// table), so it can never be matched, dismissed, or surfaced as
// Unmatched — it just silently widens the Tracked > Matchable delta.
//
// Per gap conversation the action: (1) builds the missing mirror row via
// the canonical `mirrorWebhookToFrontSyncEmail` construction (same column
// shape + version-key derivation the live webhook/reconciliation path
// uses) and transitions it forward to `applied` with
// `markFrontSyncEmailMirrorApplied` — so the row lands in
// pipeline_state='applied' + match_status='unmatched' (the column
// default), never dismissed/blocked; (2) enqueues a deterministic +
// manual-filter matching pass (`front_sync_reprocess`, cohort
// `unmatched`) so the freshly-mirrored conversation is hard-matched to a
// client exactly like any other unmatched row. Whether matching lands on
// a client, leaves it Unmatched, or an operator filter rule blocks it is
// the standard matching outcome — the action itself only ever creates
// `unmatched` rows.
//
// Idempotent / convergent: the gap predicate keys on `fse.id IS NULL`, so
// once a conversation has a mirror row it never matches again; a second
// press is a clean `not-needed` no-op. A chunk that selects rows but
// creates none (e.g. the `front_sync_emails_mirror_enabled` master switch
// is OFF, so the canonical helper no-ops) returns processed=0 and ends
// the drain rather than looping. DB-hold rules: each canonical mirror
// upsert/apply opens its own short labelled hold; the gap select + id
// re-read are chunked LIMIT scans; nothing is held across the matching
// enqueue.
//
// Prior tasks consulted (replit.md prior-task rule): #1831 (the
// `front_sync_emails` webhook-stage mirror this reuses), #2089
// (reconcile-or-close discovered-apply-tail drain shape), #2662
// (idempotent breaker-aware Front message-attribution backfill — the
// status/apply/blocked template), #2637 (deterministic + manual-filter
// matching only; cohort `unmatched`), #1969 (one-and-done background
// drain), #2293/#2363 (cross-instance advisory lock via the shared drain
// framework).
//
// Public-doc note: this action touches no Front (or any third-party) HTTP
// endpoint directly — it reconciles local rows and enqueues a local
// deterministic matching job. The enqueued matcher MAY hydrate a thread
// from Front during ingest, so the action mirrors the #2662 in-memory
// Front auth-breaker check and degrades to amber `blocked` (reconnect
// required) rather than a misleading `pending` when Front is disconnected.
const RECONCILE_FRONT_EMAILS_MISSING_MIRROR_ID =
  "reconcile_front_emails_missing_mirror";

const RECONCILE_MISSING_MIRROR_BATCH = 200;

const RECONCILE_MISSING_MIRROR_MATCH_SOURCE = "task-2670-reconcile-no-mirror";


// Shared gap predicate: a `front_email` raw record that is not orphaned,
// has no client yet, carries a Front conversation id, and has NO mirror
// row keyed by that conversation id.
const MISSING_MIRROR_GAP_WHERE = sql`
  r.source_type = 'front_email'
  AND r.external_thread_id IS NOT NULL
  AND (r.match_status IS NULL OR r.match_status <> 'orphaned')
  AND r.client_id IS NULL
  AND fse.id IS NULL
`;


async function countFrontEmailsMissingMirror(): Promise<number> {
  const result = await withDbHoldLabel(
    "maintenance:prod-actions-front-missing-mirror-count",
    () =>
      getDb().execute(sql`
        SELECT COUNT(DISTINCT r.external_thread_id)::int AS n
        FROM raw_communication_records r
        LEFT JOIN front_sync_emails fse
          ON fse.conversation_id = r.external_thread_id
        WHERE ${MISSING_MIRROR_GAP_WHERE}
      `),
  );
  return Number((result.rows as any[])[0]?.n ?? 0);
}


interface MissingMirrorGapRow {
  conversation_id: string;
  subject: string | null;
  content_text: string | null;
  participants_json: unknown;
  last_message_at: string | Date | null;
  external_source_id: string | null;
}


async function selectFrontEmailsMissingMirrorBatch(): Promise<
  MissingMirrorGapRow[]
> {
  const result = await withDbHoldLabel(
    "front_missing_mirror:select",
    () =>
      getDb().execute(sql`
        SELECT DISTINCT ON (r.external_thread_id)
          r.external_thread_id AS conversation_id,
          r.title AS subject,
          r.content_text AS content_text,
          r.participants_json AS participants_json,
          r.timestamp AS last_message_at,
          r.external_source_id AS external_source_id
        FROM raw_communication_records r
        LEFT JOIN front_sync_emails fse
          ON fse.conversation_id = r.external_thread_id
        WHERE ${MISSING_MIRROR_GAP_WHERE}
        ORDER BY r.external_thread_id, r.timestamp DESC
        LIMIT ${RECONCILE_MISSING_MIRROR_BATCH}
      `),
  );
  return result.rows as unknown as MissingMirrorGapRow[];
}


async function reconcileFrontEmailsMissingMirrorChunk(): Promise<DrainChunkResult> {
  const batch = await selectFrontEmailsMissingMirrorBatch();
  if (batch.length === 0) return { processed: 0 };

  const { mirrorWebhookToFrontSyncEmail, markFrontSyncEmailMirrorApplied } =
    await import("../frontSyncEmailMirror");

  // Resolve the drain's DB handle once (stable for this chunk's context) so
  // the mirror helpers read+write on the same connection/schema as our gap
  // select + id re-read; the getDb() call site stays lexically attributed.
  const dbHandle = await withDbAttribution(
    "maintenance:prod-actions-front-missing-mirror-write",
    () => Promise.resolve(getDb()),
  );

  const conversationIds: string[] = [];
  for (const row of batch) {
    const conversationId = row.conversation_id;
    if (!conversationId) continue;
    conversationIds.push(conversationId);
    const lastMessageId =
      row.external_source_id && row.external_source_id !== conversationId
        ? row.external_source_id
        : null;
    const snippet = row.content_text ? row.content_text.slice(0, 280) : null;
    const lastMessageAt = row.last_message_at
      ? new Date(row.last_message_at)
      : new Date();
    // Canonical construction: upsert the mirror in `discovered` (match_status
    // defaults to 'unmatched'), then transition it forward to `applied`.
    // Pass getDb() so reads + writes stay on this drain's worker handle /
    // isolated test schema (the helpers default to workerDb otherwise).
    await mirrorWebhookToFrontSyncEmail(
      {
        conversationId,
        subject: row.subject ?? null,
        snippet,
        participants:
          (row.participants_json as Array<{
            name?: string;
            email?: string;
            role?: string;
          }>) ?? null,
        lastMessageAt,
        lastMessageId,
      },
      dbHandle,
    );
    await markFrontSyncEmailMirrorApplied(conversationId, dbHandle);
  }

  if (conversationIds.length === 0) return { processed: 0 };

  // Re-read the ids of the rows that now exist for this batch's conversations.
  // A conversation with no row here means the canonical helper no-op'd (e.g.
  // the mirror master switch is OFF) — returning processed=0 ends the drain
  // cleanly instead of re-selecting the same un-creatable rows forever.
  const idRows = await withDbHoldLabel(
    "front_missing_mirror:read-ids",
    () =>
      getDb().execute(sql`
        SELECT id
        FROM front_sync_emails
        WHERE conversation_id = ANY(${bindArrayParam(conversationIds, "text")})
      `),
  );
  const ids = (idRows.rows as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return { processed: 0 };

  // Enqueue a deterministic + manual-filter matching pass per reconciled row
  // (cohort `unmatched`). Outside any DB hold. dedupeKey is stable per row so
  // a re-press / concurrent instance can't double-enqueue the same id.
  let enqueued = 0;
  for (const id of ids) {
    await enqueueJob({
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      priority: 90,
      payload: {
        syncEmailIds: [id],
        cohort: "unmatched",
        source: RECONCILE_MISSING_MIRROR_MATCH_SOURCE,
      },
      maxAttempts: 2,
      dedupeKey: `${RECONCILE_MISSING_MIRROR_MATCH_SOURCE}:${id}`,
    });
    enqueued++;
  }

  return {
    processed: ids.length,
    perKey: { mirror_reconciled: ids.length, matching_enqueued: enqueued },
  };
}


export const reconcileFrontEmailsMissingMirrorAction: ProdAction = {
  id: RECONCILE_FRONT_EMAILS_MISSING_MIRROR_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot reconciliation backfill for a historical mirror gap — a re-arm means mirror writes are skipping rows again (a writer regression to investigate first).",
  },
  title: "Reconcile Front emails with no mirror row (Task #2670)",
  description:
    "Closes the Front Console 'Tracked > Matchable' gap: `front_email` records in `raw_communication_records` whose Front conversation id (`external_thread_id`) has no `front_sync_emails` mirror row, so they are tracked but invisible to the matching surface. Per gap conversation it builds the missing mirror row via the canonical `mirrorWebhookToFrontSyncEmail` construction and transitions it to pipeline_state='applied' + match_status='unmatched' (never dismissed/blocked), then enqueues a deterministic + manual-filter matching pass (cohort `unmatched`) so the conversation is hard-matched exactly like any other unmatched row. Skips orphaned records and any conversation that already has a client. One press starts a worker-pool background drain that converges all of them in 200-conversation chunks; a second press is a no-op. Idempotent via `fse.id IS NULL`: a reconciled conversation never matches again. Degrades to a blocked (amber, reconnect-required) state when the Front auth breaker is tripped.",
  change:
    "Background-drain: for each `front_email` raw record (not orphaned, client_id NULL) whose `external_thread_id` has no `front_sync_emails` row, create the canonical mirror row in pipeline_state='applied' + match_status='unmatched', then enqueue a deterministic `front_sync_reprocess` (cohort `unmatched`) matching pass. 200-conversation chunks on the worker pool until none remain.",
  async status() {
    if (isDrainRunning(RECONCILE_FRONT_EMAILS_MISSING_MIRROR_ID)) {
      const s = getDrainState(RECONCILE_FRONT_EMAILS_MISSING_MIRROR_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const n = await withDbAttribution(
      "maintenance:prod-actions-front-missing-mirror-status",
      () => countFrontEmailsMissingMirror(),
    );
    if (n === 0) {
      return {
        state: "not-needed",
        detail:
          "No Front emails are missing a mirror row — every tracked front_email conversation has a front_sync_emails row.",
      };
    }
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail: `Front login is not connected — ${n} conversation(s) missing a mirror row are waiting. Reconnect Front in the Integrations Hub to run the reconciliation.`,
      };
    }
    return {
      state: "pending",
      detail: `${n} Front conversation(s) tracked in raw_communication_records but missing a mirror row; a single press creates each missing mirror (applied + unmatched) and enqueues deterministic matching via a background drain (${RECONCILE_MISSING_MIRROR_BATCH} per chunk).`,
    };
  },
  async apply(actorId) {
    const { frontAuthBreakerActive } = await import("../frontAuthBreaker");
    if (frontAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "Front",
        detail:
          "Front login is not connected — reconnect Front in the Integrations Hub to run the missing-mirror reconciliation.",
      };
    }
    const out = await startBackgroundDrain(
      {
        actionId: RECONCILE_FRONT_EMAILS_MISSING_MIRROR_ID,
        actionTitle: "Reconcile Front emails with no mirror row",
        attributionLabel:
          "maintenance:prod-actions-front-missing-mirror-drain",
        unit: "conversation(s)",
        countPending: () => countFrontEmailsMissingMirror(),
        runChunk: () => reconcileFrontEmailsMissingMirrorChunk(),
        formatSummary: (s) => {
          const k = s.perKey;
          return (
            `Front missing-mirror reconciliation converged — ` +
            `${k.mirror_reconciled ?? 0} mirror row(s) created (applied + unmatched), ` +
            `${k.matching_enqueued ?? 0} deterministic matching pass(es) enqueued ` +
            `(of ${s.totalAtStart} ${s.unit} at start, across ${s.chunks} chunk(s)).`
          );
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};

// ─── Inline PROD_ACTIONS entries hoisted to named consts (F7) ────────
// These were inline `killSwitchAction({...})` / object-literal entries in
// the monolithic PROD_ACTIONS array; hoisting is argument-verbatim so the
// composition root can reference them by name.

export const enableFrontHydrateSnapshotsPrunerAction = systemSettingAction({
  id: "enable_front_hydrate_snapshots_pruner",
  key: "front_hydrate_snapshots_pruner_enabled",
  targetValue: "true",
  title: "Enable front_hydrate_snapshots pruner",
  description:
    "Task #1810 — turns on the hourly pruner that deletes `front_hydrate_snapshots` rows older than `front_hydrate_snapshots_retention_days` (default 30). Batched DELETEs (LIMIT 1000) on the `worker` pool; also gated by the global `non_critical_sweeps` kill switch.",
});

// ─── Task #4790 — vendor-identifier cleanup ──────────────────────────
//
// NoBull's own vendor mail (Replit/Stripe/Tabs3 receipts) auto-matched to
// a client because the client's rows CLAIMED the vendor identifiers:
// Dellutri's `clients.email_domains` carried `stripe.com`,
// `mail.replit.com`, `tabs3.com`, and their contact row carried
// `receipts+acct_…@stripe.com` / `contact@mail.replit.com` (read from prod
// 2026-08-14: 531 + 95 + 20 vendor-cited auto-matches). The identifier
// writers and the hard matcher now refuse vendor identifiers outright
// (companyIdentity / seedingTrustPolicy / frontHardMatch, Task #4790), so
// this one-press drain removes the poison already stored:
//
//   Phase A — strip vendor-platform domains from every active client's
//   trusted-domain list and vendor-domain emails from their contact rows
//   (predicate-driven via `isVendorPlatformDomain`, audited).
//   Phase B — return every AUTO-matched conversation whose match_reason
//   cites a vendor identifier to the unmatched pool: CAS unmatch (only if
//   still auto_matched to the same client with the same reason — an
//   operator's concurrent manual decision always wins), thread-wide
//   attribution cleared via the shared stamp helper, and a
//   front_match_audit_log row per conversation. `manually_matched`
//   conversations are NEVER touched.
//
// Report-only: trusted domains that merely LOOK automated/SaaS-ish
// (`fireflies.ai`, `lawmatics-mailer.com`, …) are listed for operator
// review but never modified — removing an ambiguous domain is a human
// call (see task Out-of-scope).

const CLEANUP_VENDOR_IDENTIFIERS_ID = "cleanup_vendor_identifier_poison";
const VENDOR_CLEANUP_BATCH = 200;
const VENDOR_CLEANUP_AUDIT_SOURCE = "vendor_identifier_cleanup";

/**
 * POSIX-ERE predicate over `match_reason`: TRUE when the cited identifier
 * (the tail after `match: ` — `Exact email match: X` / `Trusted domain
 * match: D`) is a vendor-platform domain, a subdomain of one, or an email
 * address on one. Derived from `VENDOR_PLATFORM_DOMAINS` at call time so it
 * can never drift from the JS predicate. The optional `[^ ]*[@.]` prefix
 * absorbs an email local-part + `@` and/or subdomain labels, anchored at
 * end-of-reason so `notstripe.com` can never false-positive.
 */
function vendorCitedMatchReasonRegex(): string {
  const alts = [...VENDOR_PLATFORM_DOMAINS]
    .map((d) => d.replace(/\./g, "\\."))
    .join("|");
  return `match: ([^ ]*[@.])?(${alts})$`;
}

// Report-only heuristic for "suspicious" trusted domains: whole segments
// (split on `.`/`-`) that name automated-mail infrastructure, or the .ai
// TLD SaaS pattern. Deliberately conservative — whole-segment matching so
// `kmaillaw.com` ("kmaillaw") is NOT flagged while `lawmatics-mailer.com`
// ("mailer") and `fireflies.ai` (TLD) are.
const SUSPICIOUS_TRUSTED_DOMAIN_TOKENS: ReadonlySet<string> = new Set([
  "mail", "mailer", "mailers", "email", "notify", "notification",
  "notifications", "alert", "alerts", "noreply", "donotreply", "receipt",
  "receipts", "billing", "invoice", "invoices", "bounce", "smtp",
  "newsletter", "updates",
]);

function isSuspiciousTrustedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (d.endsWith(".ai")) return true;
  return d.split(/[.-]/).some((seg) => SUSPICIOUS_TRUSTED_DOMAIN_TOKENS.has(seg));
}

interface VendorPoisonScan {
  /** Clients whose trusted-domain list claims ≥1 vendor-platform domain. */
  poisonedDomainClients: Array<{
    clientId: string; firmName: string;
    vendorDomains: string[]; keepDomains: string[];
  }>;
  /** Contact rows carrying ≥1 email on a vendor-platform domain. */
  poisonedContacts: Array<{
    contactId: string; clientId: string; firmName: string;
    vendorEmails: string[]; keepEmails: string[];
  }>;
  /** Report-only: automated/SaaS-looking trusted domains left untouched. */
  suspiciousTrustedDomains: Array<{ firmName: string; domain: string }>;
}

async function scanVendorPoisonedClientRows(): Promise<VendorPoisonScan> {
  // Prospect-INCLUSIVE (matches the hard matcher's index population): a
  // poisoned prospect row would attribute vendor mail exactly like a
  // paying client's. Archived rows can't win a match, so they're skipped.
  const allClients = await storage.getClientsIncludingProspects();
  const active = allClients.filter((c) => !c.isArchived);
  const contactsByClient = active.length > 0
    ? await storage.getClientContactsForClients(active.map((c) => c.id))
    : new Map<string, Array<{ id: string; emails?: string[] | null }>>();

  const scan: VendorPoisonScan = {
    poisonedDomainClients: [],
    poisonedContacts: [],
    suspiciousTrustedDomains: [],
  };

  for (const client of active) {
    const trusted = normalizeClientEmailDomains(client.emailDomains as unknown);
    const vendorDomains = trusted.filter((d) => isVendorPlatformDomain(d));
    if (vendorDomains.length > 0) {
      scan.poisonedDomainClients.push({
        clientId: client.id,
        firmName: client.firmName,
        vendorDomains,
        keepDomains: trusted.filter((d) => !isVendorPlatformDomain(d)),
      });
    }
    for (const domain of trusted) {
      if (isVendorPlatformDomain(domain) || isPublicEmailDomain(domain) || isCompanyDomain(domain)) continue;
      if (isSuspiciousTrustedDomain(domain)) {
        scan.suspiciousTrustedDomains.push({ firmName: client.firmName, domain });
      }
    }

    const contacts = contactsByClient.get(client.id) ?? [];
    for (const contact of contacts) {
      const emails = (Array.isArray(contact.emails) ? contact.emails : [])
        .filter((e): e is string => typeof e === "string" && e.includes("@"));
      const vendorEmails = emails.filter((e) => {
        const d = extractDomain(e.trim().toLowerCase());
        return !!d && isVendorPlatformDomain(d);
      });
      if (vendorEmails.length > 0) {
        scan.poisonedContacts.push({
          contactId: contact.id,
          clientId: client.id,
          firmName: client.firmName,
          vendorEmails,
          keepEmails: emails.filter((e) => !vendorEmails.includes(e)),
        });
      }
    }
  }

  return scan;
}

// Captured by the most recent scan so `formatSummary` (which only receives
// the drain state) can append the report-only list to the terminal
// prod_action_runs detail without re-querying.
let lastSuspiciousTrustedDomainsReport = "";

function renderSuspiciousReport(list: VendorPoisonScan["suspiciousTrustedDomains"]): string {
  if (list.length === 0) {
    lastSuspiciousTrustedDomainsReport = "";
    return "";
  }
  const shown = list.slice(0, 8).map((s) => `${s.firmName}: ${s.domain}`).join("; ");
  const more = list.length > 8 ? ` (+${list.length - 8} more)` : "";
  lastSuspiciousTrustedDomainsReport =
    ` Report-only — ${list.length} suspicious trusted domain(s) left for operator review (NOT modified): ${shown}${more}.`;
  return lastSuspiciousTrustedDomainsReport;
}

async function countVendorCitedAutoMatches(): Promise<number> {
  const result = await withDbHoldLabel(
    "vendor_identifier_cleanup:count",
    () =>
      getDb().execute(sql`
        SELECT COUNT(*)::int AS n
        FROM front_sync_emails
        WHERE match_status = 'auto_matched'
          AND match_reason ~* ${vendorCitedMatchReasonRegex()}
      `),
  );
  return Number((result.rows as any[])[0]?.n ?? 0);
}

async function countVendorIdentifierPoisonPending(): Promise<number> {
  const scan = await scanVendorPoisonedClientRows();
  renderSuspiciousReport(scan.suspiciousTrustedDomains);
  const rowFixes = scan.poisonedDomainClients.length + scan.poisonedContacts.length;
  return rowFixes + (await countVendorCitedAutoMatches());
}

async function cleanupVendorIdentifierPoisonChunk(
  actorId: string | null,
  casMissIds: Set<string>,
): Promise<DrainChunkResult> {
  const perKey: Record<string, number> = {};
  const bump = (k: string, by = 1) => { perKey[k] = (perKey[k] ?? 0) + by; };
  let processed = 0;

  // ── Phase A: strip vendor identifiers from client rows (idempotent —
  // a re-run scans clean rows and finds nothing). Runs before any unmatch
  // so the matcher can't re-match phase-B rows from still-poisoned data.
  const scan = await scanVendorPoisonedClientRows();
  renderSuspiciousReport(scan.suspiciousTrustedDomains);
  for (const c of scan.poisonedDomainClients) {
    const updated = await storage.updateClient(c.clientId, {
      emailDomains: normalizeClientEmailDomains(c.keepDomains),
    });
    if (updated) {
      processed++;
      bump("client_domain_lists_cleaned");
      bump("vendor_domains_removed", c.vendorDomains.length);
      console.log(
        `[VendorCleanup] Removed vendor domain(s) [${c.vendorDomains.join(", ")}] from client ${c.firmName} (${c.clientId})`,
      );
    }
  }
  for (const c of scan.poisonedContacts) {
    const updated = await storage.updateClientContact(
      c.contactId,
      { emails: c.keepEmails },
      {
        actorUserId: actorId,
        source: VENDOR_CLEANUP_AUDIT_SOURCE,
        reason: `[task-4790] removed vendor identifier email(s): ${c.vendorEmails.join(", ")}`,
      },
    );
    if (updated) {
      processed++;
      bump("contact_rows_cleaned");
      bump("vendor_contact_emails_removed", c.vendorEmails.length);
      console.log(
        `[VendorCleanup] Removed vendor email(s) [${c.vendorEmails.join(", ")}] from contact ${c.contactId} of ${c.firmName}`,
      );
    }
  }
  if (scan.poisonedDomainClients.length > 0 || scan.poisonedContacts.length > 0) {
    invalidateHardMatchIndexes();
  }

  // ── Phase B: return vendor-cited AUTO-matches to the unmatched pool.
  // `manually_matched` rows are excluded by the status filter; CAS-missed
  // rows (concurrent operator action) are excluded for the rest of the run.
  const exclusion = casMissIds.size > 0
    ? sql` AND NOT (id = ANY(${bindArrayParam([...casMissIds], "text")}))`
    : sql``;
  const selected = await withDbHoldLabel(
    "vendor_identifier_cleanup:select",
    () =>
      getDb().execute(sql`
        SELECT id, conversation_id, matched_client_id, match_reason
        FROM front_sync_emails
        WHERE match_status = 'auto_matched'
          AND match_reason ~* ${vendorCitedMatchReasonRegex()}
          ${exclusion}
        ORDER BY id
        LIMIT ${VENDOR_CLEANUP_BATCH}
      `),
  );
  const rows = selected.rows as Array<{
    id: string;
    conversation_id: string;
    matched_client_id: string | null;
    match_reason: string | null;
  }>;

  for (const row of rows) {
    // Atomic CAS: only unmatch the row we selected — same status, same
    // client, same reason. Any concurrent change (e.g. an operator manually
    // re-matching) makes this a 0-row update and the row is left alone.
    const cas = await withDbHoldLabel(
      "vendor_identifier_cleanup:cas-unmatch",
      () =>
        getDb().execute(sql`
          UPDATE front_sync_emails
          SET match_status = 'unmatched',
              matched_client_id = NULL,
              match_confidence = NULL,
              match_reason = ${`[task-4790] Vendor-identifier cleanup: returned to unmatched (was: ${row.match_reason ?? "?"})`}
          WHERE id = ${row.id}
            AND match_status = 'auto_matched'
            AND matched_client_id IS NOT DISTINCT FROM ${row.matched_client_id}
            AND match_reason IS NOT DISTINCT FROM ${row.match_reason}
        `),
    );
    const hit = Number((cas as unknown as { rowCount?: number }).rowCount ?? 0) > 0;
    if (!hit) {
      casMissIds.add(row.id);
      bump("cas_conflict_skipped");
      continue;
    }

    // Thread-wide attribution cleared via the ONE shared helper (null clears).
    await stampThreadWideClientAttribution(row.conversation_id, null);

    const cited = /match: (.+)$/.exec(row.match_reason ?? "")?.[1] ?? null;
    await storage.createFrontMatchAuditLog({
      syncEmailId: row.id,
      conversationId: row.conversation_id,
      source: VENDOR_CLEANUP_AUDIT_SOURCE,
      outcome: "unmatched",
      priorClientId: row.matched_client_id ?? null,
      priorMatchStatus: "auto_matched",
      priorMatchMethod: row.match_reason?.includes("Exact email match:")
        ? "email_exact"
        : row.match_reason?.includes("Trusted domain match:")
          ? "email_domain"
          : null,
      newClientId: null,
      newMatchMethod: null,
      reason:
        "[task-4790] Auto-match cited a vendor identifier (payment/dev/billing platform); conversation returned to the unmatched pool.",
      matchedOn: cited,
      triggeredBy: actorId ?? undefined,
    });
    processed++;
    bump("conversations_unmatched");
  }

  return { processed, perKey };
}

export const cleanupVendorIdentifierPoisonAction: ProdAction = {
  id: CLEANUP_VENDOR_IDENTIFIERS_ID,
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "One-shot removal of vendor identifiers stored on client rows — the writers and the matcher now refuse them (Task #4790), so a re-arm means an identifier writer regressed and vendor data is being trusted again; investigate that regression first.",
  },
  title: "Strip vendor identifiers from clients + unmatch vendor-cited conversations (Task #4790)",
  description:
    "Removes NoBull's own vendor platforms (Stripe, Replit, Tabs3, and the legal-tech vendor list) from client identity data and undoes the auto-matches they caused. Prod case (read 2026-08-14): Dellutri Law Group's trusted-domain list claimed stripe.com / mail.replit.com / tabs3.com and their contact row carried receipts+acct_…@stripe.com + contact@mail.replit.com, so 646 of NoBull's own vendor receipts auto-matched into their comm log. One press starts a worker-pool background drain: phase A strips vendor-platform domains from clients.email_domains and vendor-domain emails from client_contacts rows (audited via client_contacts_audit) and invalidates the hard-match index cache; phase B CAS-unmatches every auto_matched front_sync_emails row whose match_reason cites a vendor identifier (200 per chunk) — reset to unmatched, matched client + confidence cleared, thread-wide attribution cleared via the shared stamp helper, one front_match_audit_log row per conversation. Manually matched conversations are never touched, and a concurrent operator decision always wins the CAS. Convergent: a second press finds nothing. Also reports (never modifies) any remaining suspicious-looking trusted domains for operator review.",
  change:
    "Strip vendor-platform domains/emails from client rows (audited), then CAS-reset vendor-cited auto_matched front_sync_emails rows to unmatched with thread-wide attribution cleared and a front_match_audit_log row each; 200-row chunks on the worker pool until none remain.",
  async status() {
    if (isDrainRunning(CLEANUP_VENDOR_IDENTIFIERS_ID)) {
      const s = getDrainState(CLEANUP_VENDOR_IDENTIFIERS_ID)!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const { rowFixes, convCount, suspiciousNote } = await withDbAttribution(
      "maintenance:prod-actions-vendor-identifier-cleanup-status",
      async () => {
        const scan = await scanVendorPoisonedClientRows();
        return {
          rowFixes: scan.poisonedDomainClients.length + scan.poisonedContacts.length,
          convCount: await countVendorCitedAutoMatches(),
          suspiciousNote: renderSuspiciousReport(scan.suspiciousTrustedDomains),
        };
      },
    );
    if (rowFixes === 0 && convCount === 0) {
      return {
        state: "not-needed",
        detail: `No client rows claim vendor identifiers and no auto-matched conversation cites one.${suspiciousNote}`,
      };
    }
    return {
      state: "pending",
      detail: `${rowFixes} client row(s) still claim vendor identifiers and ${convCount} auto-matched conversation(s) cite one. A single press strips the identifiers and returns those conversations to the unmatched pool via a background drain (${VENDOR_CLEANUP_BATCH} per chunk); manually matched conversations are never touched.${suspiciousNote}`,
    };
  },
  async apply(actorId) {
    // In-run CAS-conflict memory: a row that lost the CAS (concurrent
    // operator action) is never retried within this run.
    const casMissIds = new Set<string>();
    const out = await startBackgroundDrain(
      {
        actionId: CLEANUP_VENDOR_IDENTIFIERS_ID,
        actionTitle: "Vendor-identifier cleanup",
        attributionLabel: "maintenance:prod-actions-vendor-identifier-cleanup-drain",
        unit: "fix(es)",
        countPending: () => countVendorIdentifierPoisonPending(),
        runChunk: () => cleanupVendorIdentifierPoisonChunk(actorId ?? null, casMissIds),
        formatSummary: (s) => {
          const parts = [
            `${s.perKey.client_domain_lists_cleaned ?? 0} client domain list(s) cleaned (${s.perKey.vendor_domains_removed ?? 0} vendor domain(s) removed)`,
            `${s.perKey.contact_rows_cleaned ?? 0} contact row(s) cleaned (${s.perKey.vendor_contact_emails_removed ?? 0} vendor email(s) removed)`,
            `${s.perKey.conversations_unmatched ?? 0} auto-matched conversation(s) returned to the unmatched pool`,
          ];
          if (s.perKey.cas_conflict_skipped) {
            parts.push(`${s.perKey.cas_conflict_skipped} row(s) left alone — changed concurrently (operator decision wins)`);
          }
          return `Vendor-identifier cleanup: ${parts.join("; ")}.${lastSuspiciousTrustedDomainsReport}`;
        },
      },
      actorId ?? null,
    );
    if (out.state === "nothing-to-do") {
      return { state: "not-needed", detail: out.detail };
    }
    return { state: "applied", detail: out.detail, rowsAffected: 0 };
  },
};


// ─── Domain collection (F7) ──────────────────────────────────────────
// Membership list for the composition-root guard: every registry action
// this module defines. Operator-facing order lives in ./composition.ts.
export const frontSyncDomain: ProdActionDomain = {
  name: "frontSync",
  actions: [
    triggerFrontReconciliationSweepAction,
    triggerFrontAutoClosureTickAction,
    replayFrontWebhookApplyDeadLetterAction,
    drainStuckFrontDiscoveredApplyTailAction,
    reconcileFrontEmailsMissingMirrorAction,
    enableFrontHydrateSnapshotsPrunerAction,
    cleanupVendorIdentifierPoisonAction,
  ],
};
