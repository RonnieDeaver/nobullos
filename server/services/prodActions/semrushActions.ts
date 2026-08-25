// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): SEMrush operations — demand-driven cadence cutover, keep-alive ticks, stale-partial reruns.
 *
 * Split verbatim out of the monolithic server/services/prodActionsRegistry.ts.
 * Every action definition, helper, and comment below is a byte-for-byte
 * relocation (the only mechanical changes: `export ` added where the
 * composition root or a sibling module now imports a symbol, and inline
 * PROD_ACTIONS array entries hoisted into named consts). Do NOT add new
 * behavior here without the usual prod-action review gates; registration
 * order lives in ./composition.ts, not in this file.
 */

import { withDbAttribution } from "../../db";
import { storage } from "../../storage";
import {
  startBackgroundDrain,
  getDrainState,
  formatDrainProgress,
  isDrainRunning,
} from "../prodActionBackgroundDrain";
import { type ProdAction, type ProdActionDomain } from "./kernel";
import { killSwitchAction } from "./helpers";


// ─── Task #1785: SEMrush demand-driven cadence cutover ───────────────
//
// Composite, idempotent mirror of `scripts/semrush-cadence-cutover.ts`.
// Does three things on apply:
//   1. Flip three `kill_switch_*` system_settings rows to "true" so the
//      demand-driven gate, auto-retry backoff, and identical-result
//      apply-suppression are explicit in prod (these switches are NOT
//      registered in PoolEpicSwitchName — they're read elsewhere via
//      isKillSwitchEnabled which checks the bare `kill_switch_<name>`
//      row).
//   2. Seed three cadence defaults (`semrush_background_refresh_interval_ms`,
//      `semrush_refresh_staleness_threshold_hours`,
//      `semrush_active_client_window_days`) only when the row is
//      missing — never clobber an operator override.
//   3. Unpause `semrush_background_refresh` and `semrush_report_refresh`
//      via the canonical queueDrainControl helper.
// `status()` reports `not-needed` only when every sub-step is already
// in its target state; otherwise it lists exactly which sub-steps would
// run. Re-running after a successful apply lands at `not-needed`.
const SEMRUSH_CUTOVER_SWITCHES = [
  "semrush_demand_driven_refresh",
  "semrush_auto_retry_backoff",
  "semrush_identical_result_apply_suppression",
] as const;

const SEMRUSH_CUTOVER_SETTINGS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "semrush_background_refresh_interval_ms", value: String(12 * 60 * 60_000) },
  { key: "semrush_refresh_staleness_threshold_hours", value: "24" },
  { key: "semrush_active_client_window_days", value: "14" },
];

const SEMRUSH_CUTOVER_QUEUES_TO_RESUME = [
  "semrush_background_refresh",
  "semrush_report_refresh",
] as const;


export const semrushCadenceCutoverAction: ProdAction = {
  id: "cutover_semrush_demand_driven_cadence",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Deliberate cadence-mode cutover (three switches, seeded defaults, and unpauses in one press) — an operator policy decision, never auto-fired.",
  },
  title: "Cut over SEMrush demand-driven cadence (Task #1785)",
  description:
    "Idempotent replacement for scripts/semrush-cadence-cutover.ts. Flips the three SEMrush cadence kill switches ON, seeds the three cadence defaults when missing (never clobbers operator overrides), and unpauses the two SEMrush refresh queues. Apply-heatmap and manual `triggerReportRefresh` are untouched.",
  change:
    "kill_switch_semrush_{demand_driven_refresh,auto_retry_backoff,identical_result_apply_suppression}=true + 3 cadence settings (only-if-missing) + unpause semrush_background_refresh & semrush_report_refresh.",
  async status() {
    const { setQueuePause: _unused, isQueuePaused, ensureQueueDrainStateLoaded } = await import(
      "../queueDrainControl"
    );
    void _unused;
    await ensureQueueDrainStateLoaded();
    const switchKeys = SEMRUSH_CUTOVER_SWITCHES.map((n) => `kill_switch_${n}`);
    const settingKeys = SEMRUSH_CUTOVER_SETTINGS.map((s) => s.key);
    const rows = await storage.getSystemSettings([...switchKeys, ...settingKeys]);
    const pendingSteps: string[] = [];
    for (const n of SEMRUSH_CUTOVER_SWITCHES) {
      if ((rows[`kill_switch_${n}`] ?? "").toLowerCase() !== "true") {
        pendingSteps.push(`switch ${n}`);
      }
    }
    for (const { key, value } of SEMRUSH_CUTOVER_SETTINGS) {
      if (!rows[key]) pendingSteps.push(`seed ${key}=${value}`);
    }
    for (const q of SEMRUSH_CUTOVER_QUEUES_TO_RESUME) {
      if (isQueuePaused(q)) pendingSteps.push(`unpause ${q}`);
    }
    if (pendingSteps.length === 0) {
      return { state: "not-needed", detail: "All switches, settings, and queue states already cut over." };
    }
    return {
      state: "pending",
      detail: `${pendingSteps.length} sub-step(s) pending: ${pendingSteps.join("; ")}.`,
    };
  },
  async apply(actorId) {
    const { setQueuePause, isQueuePaused, ensureQueueDrainStateLoaded } = await import(
      "../queueDrainControl"
    );
    await ensureQueueDrainStateLoaded();
    const actor = actorId ?? "prod-actions:cutover_semrush_demand_driven_cadence";
    const switchKeys = SEMRUSH_CUTOVER_SWITCHES.map((n) => `kill_switch_${n}`);
    const settingKeys = SEMRUSH_CUTOVER_SETTINGS.map((s) => s.key);
    const before = await storage.getSystemSettings([...switchKeys, ...settingKeys]);
    const applied: string[] = [];
    const failures: string[] = [];
    for (const n of SEMRUSH_CUTOVER_SWITCHES) {
      const key = `kill_switch_${n}`;
      if ((before[key] ?? "").toLowerCase() !== "true") {
        await storage.setSystemSetting(key, "true", actor);
        applied.push(`${n}=true`);
      }
    }
    for (const { key, value } of SEMRUSH_CUTOVER_SETTINGS) {
      if (!before[key]) {
        await storage.setSystemSetting(key, value, actor);
        applied.push(`${key}=${value}`);
      }
    }
    for (const q of SEMRUSH_CUTOVER_QUEUES_TO_RESUME) {
      if (isQueuePaused(q)) {
        try {
          await setQueuePause(q, false, actor);
          applied.push(`unpause:${q}`);
        } catch (err: any) {
          failures.push(`unpause:${q}:${err?.message ?? String(err)}`);
        }
      }
    }
    // Promote any sub-step failure to an error outcome — the architect
    // review (Task #1804 follow-up) specifically called out that
    // silently rendering "applied" while a required queue stayed paused
    // undermines the universal-button guarantee.
    if (failures.length > 0) {
      const appliedNote = applied.length > 0 ? ` Partially applied: ${applied.join("; ")}.` : "";
      return {
        state: "error",
        detail: `${failures.length} sub-step(s) failed: ${failures.join("; ")}.${appliedNote}`,
      };
    }
    if (applied.length === 0) {
      return { state: "not-needed", detail: "All sub-steps were already in target state." };
    }
    return { state: "applied", detail: `Applied ${applied.length} sub-step(s): ${applied.join("; ")}.` };
  },
};


const SEMRUSH_PARTIAL_RERUN_STALE_MS = 6 * 60 * 60_000; // 6h: leave fresh/in-flight partials alone

const SEMRUSH_PARTIAL_RERUN_CHUNK = 3; // locations per chunk — gentle on SEMrush

const SEMRUSH_PARTIAL_RERUN_DELAY_MS = 500;

const SEMRUSH_PARTIAL_RERUN_STALE_HOURS = Math.round(SEMRUSH_PARTIAL_RERUN_STALE_MS / 3_600_000);


// ──────────── Task #3666: SEMrush keep-alive tick on demand ────────────
//
// Provides a CEO-level button to force one SEMrush token keep-alive rotation
// immediately (bypassing the freshness / age checks), so the operator can
// prove the refresh endpoint is working right after a publish instead of
// waiting for the scheduled rotation window to open.
//
// The tick runs non-authoritatively — a terminal failure does NOT wipe
// credentials or trip the auth-dead breaker. The outcome detail surfaces the
// exact OAuth error so the operator can diagnose endpoint / credential issues.
export const semrushKeepAliveTickAction: ProdAction = {
  id: "semrush_keepalive_rotate_now",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "On-demand diagnostic rotation outside the scheduled keep-alive loop — the loop owns routine freshness; firing this automatically would duplicate it.",
  },
  title: "Rotate SEMrush token now (keep-alive tick)",
  description:
    "Forces one immediate keep-alive rotation of the SEMrush OAuth token, bypassing the normal freshness and age checks. Runs non-authoritatively — a terminal failure does NOT wipe credentials or engage the auth-dead breaker. Use this after a publish to confirm the refresh endpoint is functioning and to advance the token before the scheduled rotation window opens.",
  change:
    "Calls runSemrushTokenKeepAliveTick({ force: true }) once. On success writes new semrush_access_token + semrush_refresh_token + semrush_token_last_refreshed_at to system_settings. On failure surfaces the exact OAuth error detail without touching stored credentials.",
  async status() {
    // Task #4762 — key mode first: the OAuth keep-alive loop is dormant by
    // design when the v4 API key is in use, so there is nothing to nudge.
    const { isSemrushKeyMode } = await import("../semrushAuthMode");
    if (isSemrushKeyMode()) {
      return {
        state: "not-needed",
        detail:
          "SEMrush runs in API-key mode (SEMRUSH_V4_API_KEY) — the OAuth keep-alive loop is dormant by design and no token rotation is needed.",
      };
    }
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    const refreshSetting = await storage
      .getSystemSetting("semrush_refresh_token")
      .catch(() => null);
    if (!refreshSetting?.value) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail:
          "No SEMrush tokens stored — reconnect SEMrush via Integrations Hub → SEMrush first.",
      };
    }
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail:
          "SEMrush auth-dead breaker is open — reconnect SEMrush in the Integrations Hub, then retry.",
      };
    }
    const {
      getSemrushKeepAliveHeartbeat,
      getSemrushKeepAliveIntervalMs,
      isSemrushKeepAliveSchedulerEligibleHere,
    } = await import("../semrushTokenKeepAliveScheduler");
    const hb = await getSemrushKeepAliveHeartbeat().catch(() => null);
    const intervalMs = await getSemrushKeepAliveIntervalMs().catch(
      () => 6 * 60 * 60 * 1000,
    );
    const cadenceHours = Math.round((intervalMs / 3_600_000) * 10) / 10;
    // Task #4762 — judge loop health against the loop's OWN cadence (2×
    // interval grace), not a hard-coded window: the old "successful run
    // within 4h" predicate against a 6h loop re-armed this row between
    // every pair of healthy ticks — a perpetual amber nudge for a loop
    // that was doing its job. Healthy loop ⇒ not-needed; the on-demand
    // rotation stays available via Apply.
    if (hb?.lastSuccessAt) {
      const ageMs = Date.now() - new Date(hb.lastSuccessAt).getTime();
      if (ageMs < 2 * intervalMs) {
        return {
          state: "not-needed",
          detail: `Scheduled keep-alive loop is healthy — last successful tick ${new Date(
            hb.lastSuccessAt,
          ).toUTCString()} (loop cadence ${cadenceHours}h; healthy = within 2× cadence). On-demand rotation remains available via Apply.`,
        };
      }
    }
    if (!isSemrushKeepAliveSchedulerEligibleHere()) {
      // Dev/preview: the scheduler is dormant outside deployments, so a
      // stale heartbeat here is expected, not actionable — the deployed
      // loop owns routine rotation.
      return {
        state: "not-needed",
        detail:
          "Keep-alive scheduler is dormant outside deployments (SEMRUSH_TOKEN_KEEPALIVE_FORCE_ENABLE unset) — nothing to verify from this environment; the deployed loop owns routine rotation.",
      };
    }
    return {
      state: "pending",
      detail: hb?.lastSuccessAt
        ? `Keep-alive loop looks stale: last successful tick ${new Date(
            hb.lastSuccessAt,
          ).toUTCString()} exceeds 2× its ${cadenceHours}h cadence${
            hb.lastError ? ` (last error: ${hb.lastError})` : ""
          } — force one rotation to verify the refresh endpoint and advance the token.`
        : "Keep-alive loop has never recorded a successful tick in this deployment — force one rotation to verify the SEMrush OAuth refresh endpoint.",
    };
  },
  async apply(_actorId) {
    const { runSemrushTokenKeepAliveTick } = await import("../semrushApi");
    const result = await runSemrushTokenKeepAliveTick({ force: true });
    switch (result.action) {
      case "refreshed":
        return {
          state: "applied",
          detail:
            "Keep-alive rotation succeeded — SEMrush access + refresh tokens rotated and stored.",
        };
      case "skipped":
        if (result.reason === "no_tokens") {
          return {
            state: "blocked",
            integration: "SEMrush",
            detail: "No SEMrush tokens found — reconnect SEMrush via Integrations Hub first.",
          };
        }
        if (result.reason === "breaker_open") {
          return {
            state: "blocked",
            integration: "SEMrush",
            detail:
              "SEMrush auth-dead breaker is open — reconnect SEMrush in the Integrations Hub.",
          };
        }
        if (result.reason === "disabled") {
          return {
            state: "error",
            detail:
              "SEMrush keep-alive kill switch is off (semrush_token_keepalive_enabled = false). Re-enable it in Admin → System Settings.",
          };
        }
        // "fresh" should not occur with force:true but handle defensively.
        return {
          state: "not-needed",
          detail: `Token is within freshness threshold — skipped (${result.reason}). Use force mode or wait for the rotation window.`,
        };
      case "terminal_error":
        return {
          state: "error",
          detail: `Keep-alive rotation hit a terminal OAuth error: ${result.oauthError ?? "unknown"}. The SEMrush device-flow refresh endpoint may require client credentials (client_id + client_secret) that are unavailable without a registered Semrush Auth app. See KEEP_ALIVE_RUNBOOK.md for the investigation findings and post-mortem.`,
        };
      case "transient_error":
        return {
          state: "error",
          detail: `Keep-alive rotation failed transiently: ${result.message}`,
        };
    }
  },
};


export const rerunStaleSemrushPartialsAction: ProdAction = {
  id: "rerun_stale_semrush_partials",
  // Task #4054 — routine operation re-produces work for this action; the
  // enrolled self-heal loop (below) drains it automatically, so a healthy
  // pending state is auto-managed maintenance, not operator work.
  convergence: { kind: "continuous", loop: "prod-action self-heal scheduler" },
  title: "Re-run stale Semrush partial / paused locations (Task #2265)",
  description:
    "Re-drives Local Dominance per-location sync rows stuck in `partial` (imported some-but-not-all keywords and never completed) or leftover `paused_auth` (a sweep paused on missing auth that no later healthy sweep cleared), older than " +
    String(SEMRUSH_PARTIAL_RERUN_STALE_HOURS) +
    "h. A single press starts a worker-pool background drain that resets each stuck location's retry budget and re-runs ONLY that location, " +
    String(SEMRUSH_PARTIAL_RERUN_CHUNK) +
    " location(s) per chunk, until none remain. SEMrush circuit-breaker and auth-breaker aware (stops cleanly on circuit-open / not-connected; a later run resumes). Idempotent: only ever touches partial / paused_auth rows.",
  change:
    "Per stuck row: resetForManualRetry(clientId, locationId, campaignId) then syncSingleClient(clientId, { restrictToLocationId }) on the worker pool, " +
    String(SEMRUSH_PARTIAL_RERUN_CHUNK) +
    " location(s)/chunk. No schema change; writes go through the normal sync path.",
  // Task #2086 — recurring + idempotent + breaker-aware, so it opts into the
  // self-heal scheduler on an hourly cadence (longer backoff when idle/blocked).
  selfHeal: { cadenceMs: 60 * 60_000, backoffMs: 6 * 60 * 60_000 },
  async status() {
    if (isDrainRunning("rerun_stale_semrush_partials")) {
      const s = getDrainState("rerun_stale_semrush_partials")!;
      return {
        state: "pending",
        working: true,
        detail: `Background drain in progress — ${formatDrainProgress(s)}.`,
      };
    }
    const { listStalePartialAndPausedAuth } = await import("../semrushLocationSyncState");
    const rows = await withDbAttribution(
      "maintenance:prod-actions-rerun-stale-semrush-partials-count",
      () => listStalePartialAndPausedAuth(SEMRUSH_PARTIAL_RERUN_STALE_MS),
    );
    if (rows.length === 0) {
      return {
        state: "not-needed",
        detail: `No Semrush location is stuck in partial / paused_auth older than ${SEMRUSH_PARTIAL_RERUN_STALE_HOURS}h.`,
      };
    }
    const partial = rows.filter((r) => r.status === "partial").length;
    const paused = rows.length - partial;
    // Task #2123 / #2111 pattern — there is work, but every re-run would
    // short-circuit while the SEMrush auth-breaker is open. Report amber
    // "needs reconnect" naming SEMrush instead of a misleading "pending".
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail: `SEMrush login is not connected — ${rows.length} stuck location(s) (${partial} partial, ${paused} paused_auth) are waiting. Reconnect SEMrush in the Integrations Hub, then re-run.`,
      };
    }
    return {
      state: "pending",
      detail: `${rows.length} stuck location(s) (${partial} partial, ${paused} paused_auth) older than ${SEMRUSH_PARTIAL_RERUN_STALE_HOURS}h; a single press re-runs them ${SEMRUSH_PARTIAL_RERUN_CHUNK} location(s) per chunk.`,
    };
  },
  async apply(actorId) {
    const { semrushAuthBreakerActive } = await import("../semrushAuthBreaker");
    if (semrushAuthBreakerActive()) {
      return {
        state: "blocked",
        integration: "SEMrush",
        detail:
          "SEMrush login is not connected — reconnect SEMrush in the Integrations Hub, then re-run.",
      };
    }
    const { listStalePartialAndPausedAuth, resetForManualRetry } = await import("../semrushLocationSyncState");
    const { syncSingleClient } = await import("../localDominanceSyncWorker");
    const breaker = await import("../semrushCircuitBreaker");
    // `attempted` prevents the chunk re-query from re-selecting a location we
    // already re-drove this run (a still-partial outcome leaves the row a
    // candidate). `stop` ends the drain cleanly on breaker-open. Both are
    // scoped to a single drain run; a fresh press starts clean.
    const attempted = new Set<string>();
    let stop = false;
    const keyOf = (r: { clientId: string; locationId: string; campaignId: string }) =>
      `${r.clientId}|${r.locationId}|${r.campaignId}`;
    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

    const out = await startBackgroundDrain(
      {
        actionId: "rerun_stale_semrush_partials",
        actionTitle: "Re-run stale Semrush partial / paused locations",
        attributionLabel: "maintenance:prod-actions-rerun-stale-semrush-partials",
        unit: "location(s)",
        countPending: async () => {
          const rows = await withDbAttribution(
            "maintenance:prod-actions-rerun-stale-semrush-partials-count",
            () => listStalePartialAndPausedAuth(SEMRUSH_PARTIAL_RERUN_STALE_MS),
          );
          return rows.filter((r) => !attempted.has(keyOf(r))).length;
        },
        runChunk: async () => {
          if (stop) return { processed: 0 };
          // Re-check the auth-breaker each chunk — it may have tripped mid-drain
          // (token wiped by an authoritative refresh elsewhere). Stop cleanly so
          // we don't burn through locations with a dead credential.
          if (semrushAuthBreakerActive()) {
            stop = true;
            return { processed: 0 };
          }
          const rows = await withDbAttribution(
            "maintenance:prod-actions-rerun-stale-semrush-partials-count",
            () => listStalePartialAndPausedAuth(SEMRUSH_PARTIAL_RERUN_STALE_MS),
          );
          const fresh = rows
            .filter((r) => !attempted.has(keyOf(r)))
            .slice(0, SEMRUSH_PARTIAL_RERUN_CHUNK);
          if (fresh.length === 0) return { processed: 0 };

          let processed = 0;
          let reran = 0;
          let stillStuck = 0;
          let failed = 0;
          for (const row of fresh) {
            if (stop) break;
            // SEMrush circuit-breaker pre-check (manual probe semantics so an
            // open breaker admits one forced attempt; if even that is refused
            // we stop and let a later run resume).
            const decision = breaker.shouldAllowRequest({ isManual: true });
            if (!decision.allowed) {
              stop = true;
              break;
            }
            const key = { clientId: row.clientId, locationId: row.locationId, campaignId: row.campaignId };
            await withDbAttribution(
              "maintenance:prod-actions-rerun-stale-semrush-partials",
              () => resetForManualRetry(key),
            );
            const res = await syncSingleClient(row.clientId, {
              origin: "scheduled_background",
              restrictToLocationId: row.locationId,
            });
            attempted.add(keyOf(row));
            processed++;
            if (res.success) reran++;
            else {
              failed++;
            }
            // Re-read the row: if it's still partial/paused_auth the re-run
            // didn't fully resolve it (it stays a candidate but is `attempted`
            // for this run so we don't spin on it).
            const after = await withDbAttribution(
              "maintenance:prod-actions-rerun-stale-semrush-partials-count",
              () => listStalePartialAndPausedAuth(0),
            );
            if (after.some((r) => keyOf(r) === keyOf(row))) stillStuck++;
            if (SEMRUSH_PARTIAL_RERUN_DELAY_MS) await sleep(SEMRUSH_PARTIAL_RERUN_DELAY_MS);
          }
          return {
            processed,
            perKey: {
              reran,
              ...(stillStuck > 0 ? { stillStuck } : {}),
              ...(failed > 0 ? { failed } : {}),
            },
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

// ─── Inline PROD_ACTIONS entries hoisted to named consts (F7) ────────
// These were inline `killSwitchAction({...})` / object-literal entries in
// the monolithic PROD_ACTIONS array; hoisting is argument-verbatim so the
// composition root can reference them by name.

export const enableSemrushPersistentEnrichmentCacheAction = killSwitchAction({
  id: "enable_semrush_persistent_enrichment_cache",
  switchName: "semrush_persistent_enrichment_cache_enabled",
  targetValue: true,
  title: "Enable SEMrush persistent enrichment cache",
  description:
    "Pool Epic Phase 1.2 — turns on the read-through/write-through durable cache for SEMrush campaign keyword + location enrichment so restarts don't refetch every campaign. Gating reads via isPoolEpicSwitchEnabled in enrichCampaigns.",
});

// ─── Domain collection (F7) ──────────────────────────────────────────
// Membership list for the composition-root guard: every registry action
// this module defines. Operator-facing order lives in ./composition.ts.
export const semrushDomain: ProdActionDomain = {
  name: "semrush",
  actions: [
    semrushKeepAliveTickAction,
    rerunStaleSemrushPartialsAction,
    semrushCadenceCutoverAction,
    enableSemrushPersistentEnrichmentCacheAction,
  ],
};
