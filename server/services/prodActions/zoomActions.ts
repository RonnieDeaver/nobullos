// @db-pool-intent: worker
/**
 * Prod-action domain module (F7, Task #4154): Zoom platform — S2S cutover/rollback, legacy token retirement, unmatched-backlog re-match, stale apply-event drains.
 *
 * Split verbatim out of the monolithic server/services/prodActionsRegistry.ts.
 * Every action definition, helper, and comment below is a byte-for-byte
 * relocation (the only mechanical changes: `export ` added where the
 * composition root or a sibling module now imports a symbol, and inline
 * PROD_ACTIONS array entries hoisted into named consts). Do NOT add new
 * behavior here without the usual prod-action review gates; registration
 * order lives in ./composition.ts, not in this file.
 */

import { runWithWorkerDb, withDbAttribution } from "../../db";
import { storage } from "../../storage";
import { getLastSuccessfulProdActionRun } from "../../storage/prodActionRuns";
import {
  applyZoomAuthModeChange,
  getZoomAuthMode,
  hasZoomS2sCredentials,
  retireLegacyZoomOauthTokens,
  ZOOM_LEGACY_TOKEN_SETTING_KEYS,
  ZOOM_S2S_CUTOVER_AT_SETTING,
  ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING,
} from "../zoomIntegration";
import { type ProdAction, type ProdActionDomain } from "./kernel";


// ─── Task #4019: Zoom Server-to-Server switchover finishers ─────────────────
//
// Two one-and-done surfaces that finish the #3973/#3982 Zoom S2S cutover from
// the CEO panel (runbook: ZOOM.md § Server-to-Server OAuth):
//
//   1. `zoom_s2s_auth_mode_cutover` — the production flip. Runs the live S2S
//      preflight (token mint + scope parity + API probe) and, only when
//      `ready: true`, flips `zoom_auth_mode` oauth → s2s via the SAME shared
//      sequence as the team-lead auth-mode route (applyZoomAuthModeChange).
//   2. `retire_legacy_zoom_oauth_tokens` — the § Retirement token clearing,
//      self-gated so "Apply all" can never fire it early: s2s must be the
//      live mode, the cutover must have soaked ≥72h (zoom_s2s_cutover_at,
//      stamped by every oauth→s2s flip), and a live webhook delivery must
//      have verified via the S2S app's signature within the last 7 days
//      (zoom_s2s_webhook_last_verified_at, stamped by the receiver).
//
// Rollback is deliberately NOT a prod action: POST
// /api/integrations/zoom/auth-mode {"mode":"oauth"} (team-lead, break-glass).
// Registering it would let one "Apply all" bounce the mode back and forth;
// for the same reason the cutover action parks itself (prod_action_runs
// audit guard) after an operator rollback instead of auto-re-flipping.

const ZOOM_S2S_CUTOVER_ACTION_ID = "zoom_s2s_auth_mode_cutover";

const ZOOM_LEGACY_RETIREMENT_MIN_SOAK_MS = 72 * 60 * 60 * 1000;

const ZOOM_S2S_WEBHOOK_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;


export const zoomS2sCutoverAction: ProdAction = {
  id: ZOOM_S2S_CUTOVER_ACTION_ID,
  // One-shot preflight-gated mode flip — settles at s2s (or parks after a
  // rollback); re-arming requires a deliberate operator rollback, not inflow.
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "Deliberate auth-mode cutover with external preconditions (S2S app credentials and webhook state per ZOOM.md) — the operator initiates it; after a rollback it must never auto-re-flip.",
  },
  title: "Flip Zoom to Server-to-Server auth (Task #4019)",
  description:
    "Finishes the Zoom S2S cutover prepared by Task #3982. Runs the live S2S preflight — token mint, scope parity (the full :admin scope closure incl. the cloud_recording rename), API reachability — and ONLY when it reports ready:true flips zoom_auth_mode oauth → s2s: clears mode gates/breakers, stamps the retirement soak clock (zoom_s2s_cutover_at), invalidates the integrations status cache and kicks auto-sync. A not-ready preflight makes NO change and reports the failing detail. Afterwards verify per ZOOM.md § Staged cutover step 4 (badge green, keep-alive `skipped/s2s_mode` ticks, webhook-driven zoom_meeting_apply jobs) and let it soak — the retirement action unlocks after 72h + live S2S webhook evidence. Rollback (break-glass): team-lead POST /api/integrations/zoom/auth-mode {\"mode\":\"oauth\"}; expect one legacy reconnect. After a rollback this action parks itself instead of auto-flipping on the next Apply-all.",
  change:
    "Preflight-gated write of system_settings.zoom_auth_mode → s2s (+ zoom_s2s_cutover_at stamp, audit row, status-cache invalidation, auto-sync kick). No Zoom-side or legacy-token state is touched.",
  async status() {
    const mode = await getZoomAuthMode();
    if (mode === "s2s") {
      return {
        state: "applied",
        detail:
          "zoom_auth_mode is s2s — cutover live. Soak per ZOOM.md § Staged cutover step 4; the retirement action unlocks after 72h + S2S webhook evidence.",
      };
    }
    const priorFlip = await runWithWorkerDb(() =>
      getLastSuccessfulProdActionRun(ZOOM_S2S_CUTOVER_ACTION_ID),
    );
    if (priorFlip) {
      return {
        state: "not-needed",
        detail: `Cutover was applied ${new Date(priorFlip.appliedAt).toISOString()} but the mode is oauth again — an operator rolled back. Parked: re-cutover only via the team-lead auth-mode route (never automatically via Apply-all).`,
      };
    }
    if (!hasZoomS2sCredentials()) {
      return {
        state: "blocked",
        detail:
          "ZOOM_S2S_ACCOUNT_ID / ZOOM_S2S_CLIENT_ID / ZOOM_S2S_CLIENT_SECRET are not configured in this environment — set the Deployments secrets (ZOOM.md § Setup) and redeploy.",
      };
    }
    return {
      state: "pending",
      detail:
        "Ready to flip: runs the live S2S preflight and, only on ready:true, switches zoom_auth_mode oauth → s2s. A not-ready preflight changes nothing. Expect real-time webhooks to resume — the legacy app's webhook feed has been dead since mid-May 2026 and ingestion has been riding the 2 AM reconciliation sweep.",
    };
  },
  async apply(actorId) {
    const mode = await getZoomAuthMode();
    if (mode === "s2s") {
      return { state: "not-needed", detail: "Already in s2s mode." };
    }
    const priorFlip = await runWithWorkerDb(() =>
      getLastSuccessfulProdActionRun(ZOOM_S2S_CUTOVER_ACTION_ID),
    );
    if (priorFlip) {
      return {
        state: "not-needed",
        detail:
          "A previous cutover was rolled back by an operator — refusing to auto-flip. Re-cutover via the team-lead auth-mode route when ready.",
      };
    }
    if (!hasZoomS2sCredentials()) {
      return {
        state: "blocked",
        detail:
          "ZOOM_S2S_* credentials are not configured — set the Deployments secrets and redeploy first.",
      };
    }
    const result = await applyZoomAuthModeChange("s2s", { actorId: actorId ?? null });
    if (result.kind === "not_ready") {
      const p = result.preflight;
      const scopeNote =
        p.missingScopes.length > 0 ? ` missingScopes=[${p.missingScopes.join(", ")}]` : "";
      return {
        state: "blocked",
        detail: `S2S preflight not ready — no change made. mintOk=${p.mintOk} apiOk=${p.apiOk}${scopeNote}${p.error ? ` error=${p.error}` : ""}. Fix the S2S Marketplace app / secrets; the action stays available until the preflight passes.`,
      };
    }
    if (result.kind === "unchanged") {
      return { state: "not-needed", detail: "Already in s2s mode." };
    }
    return {
      state: "applied",
      detail:
        "zoom_auth_mode flipped oauth → s2s after a ready preflight (status cache invalidated, auto-sync kicked, soak clock stamped). Watch: integrations badge green, keep-alive `skipped/s2s_mode` ticks, first `[Zoom Webhook] Ingested` lines at non-reconciliation hours. Rollback (break-glass): team-lead POST auth-mode {\"mode\":\"oauth\"} + one legacy reconnect.",
    };
  },
};


/**
 * Shared triple gate for the retirement action — evaluated identically by
 * status() (so the panel shows WHY it is parked, e.g. the soak countdown)
 * and by apply() (so Apply-all can never clear the rows early).
 */
async function zoomLegacyRetirementGate(): Promise<{ ok: boolean; detail: string }> {
  const mode = await getZoomAuthMode();
  if (mode !== "s2s") {
    return {
      ok: false,
      detail:
        "zoom_auth_mode is oauth — the S2S cutover must be live (see the flip action) before the legacy token rows can be cleared.",
    };
  }
  const cutoverRow = await storage.getSystemSetting(ZOOM_S2S_CUTOVER_AT_SETTING);
  const cutoverAtMs = cutoverRow?.value ? new Date(cutoverRow.value).getTime() : NaN;
  if (!Number.isFinite(cutoverAtMs)) {
    return {
      ok: false,
      detail:
        "No zoom_s2s_cutover_at stamp found — flip via the cutover action (or team-lead route) so the 72h soak clock starts.",
    };
  }
  const soakMs = Date.now() - cutoverAtMs;
  if (soakMs < ZOOM_LEGACY_RETIREMENT_MIN_SOAK_MS) {
    const elapsedH = Math.floor(soakMs / 3_600_000);
    const leftH = Math.ceil((ZOOM_LEGACY_RETIREMENT_MIN_SOAK_MS - soakMs) / 3_600_000);
    return {
      ok: false,
      detail: `Soaking: ${elapsedH}h of 72h in s2s mode (~${leftH}h to go).`,
    };
  }
  const verifiedRow = await storage.getSystemSetting(ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING);
  const verifiedAtMs = verifiedRow?.value ? new Date(verifiedRow.value).getTime() : NaN;
  if (!Number.isFinite(verifiedAtMs)) {
    return {
      ok: false,
      detail:
        "No live webhook delivery has verified via the S2S app's signature yet (zoom_s2s_webhook_last_verified_at unset) — confirm the S2S app's Event Subscriptions are Validated + Saved and wait for a real meeting/recording event (ZOOM.md § Retirement).",
    };
  }
  const evidenceAgeMs = Date.now() - verifiedAtMs;
  if (evidenceAgeMs > ZOOM_S2S_WEBHOOK_EVIDENCE_MAX_AGE_MS) {
    const days = Math.floor(evidenceAgeMs / 86_400_000);
    return {
      ok: false,
      detail: `Last S2S-verified webhook is ~${days}d old (> 7d) — confirm deliveries still flow before retiring the legacy app.`,
    };
  }
  return {
    ok: true,
    detail: `s2s live for ${Math.floor(soakMs / 3_600_000)}h; last S2S-verified webhook ${Math.max(1, Math.round(evidenceAgeMs / 60_000))}m ago`,
  };
}


export const retireLegacyZoomOauthTokensAction: ProdAction = {
  id: "retire_legacy_zoom_oauth_tokens",
  // One-shot triple-gated retirement delete — not-needed once the rows are
  // gone; nothing routinely re-produces legacy token rows.
  convergence: { kind: "converging" },
  // Task #4762 L2 decision — safe to auto-fire BECAUSE the triple gate
  // (s2s mode + ≥72h soak + webhook-verified ≤7d) lives inside BOTH
  // status() and apply(): a self-heal press before the gates pass settles
  // `blocked` (no delete, no failure streak) and the scheduler simply
  // retries after backoff. Once the operator reconnect + soak + webhook
  // proof all land, the next pass completes the retirement without
  // another human press. During the soak window the row reads blocked —
  // amber by design (documented transitional state, PROD_ACTION_SELF_HEAL.md).
  selfHeal: { cadenceMs: 6 * 60 * 60 * 1000, backoffMs: 6 * 60 * 60 * 1000 },
  title: "Retire legacy Zoom OAuth token rows (Task #4019)",
  description:
    "Final ZOOM.md § Retirement database step: deletes the three legacy user-level OAuth token rows (zoom_access_token / zoom_refresh_token / zoom_token_expires_at; values are never logged — the audit row records key names only). Triple-gated so Apply-all can never fire it early: (1) zoom_auth_mode must be s2s, (2) the cutover must have soaked ≥72h (zoom_s2s_cutover_at), (3) a live webhook delivery must have verified via the S2S app's signature within the last 7 days (zoom_s2s_webhook_last_verified_at — only the S2S Secret Token can produce it, so it is exactly the \"live webhook verified through the S2S app\" proof the runbook requires). zoom_granted_scopes survives (still written by s2s mints). AFTER this applies, finish the manual remainder per ZOOM.md § Retirement: DEACTIVATE the legacy user-level Marketplace app (never delete it; never use the in-app disconnect route — that also stops reconciliation), move the S2S Secret Token value into ZOOM_WEBHOOK_SECRET_TOKEN, unset ZOOM_S2S_WEBHOOK_SECRET_TOKEN, republish. Clearing the rows removes the instant rollback path — a later rollback to oauth needs one operator reconnect, which § Rollback already expects.",
  change:
    "DELETE the system_settings rows zoom_access_token, zoom_refresh_token, zoom_token_expires_at (audit row records key names only). Nothing else — Marketplace deactivation and webhook-secret promotion stay manual (ZOOM.md § Retirement).",
  async status() {
    const rows = await Promise.all(
      ZOOM_LEGACY_TOKEN_SETTING_KEYS.map((k) => storage.getSystemSetting(k)),
    );
    const presentKeys = ZOOM_LEGACY_TOKEN_SETTING_KEYS.filter((_, i) => Boolean(rows[i]?.value));
    const mode = await getZoomAuthMode();
    if (presentKeys.length === 0) {
      if (mode === "s2s") {
        return {
          state: "applied",
          detail:
            "Legacy token rows already cleared — single-app steady state. Remaining manual steps (if not yet done): deactivate the legacy Marketplace app, promote the S2S Secret Token into ZOOM_WEBHOOK_SECRET_TOKEN, unset ZOOM_S2S_WEBHOOK_SECRET_TOKEN, republish.",
        };
      }
      return {
        state: "blocked",
        detail:
          "Legacy token rows are absent but zoom_auth_mode is oauth — anomalous (oauth mode has no credentials to run on). Investigate before any Marketplace changes; an operator reconnect (ZOOM.md § Credential rotation) restores oauth if that mode is intended.",
      };
    }
    const gate = await zoomLegacyRetirementGate();
    if (!gate.ok) {
      return { state: "blocked", detail: gate.detail };
    }
    return {
      state: "pending",
      detail: `All gates passed (${gate.detail}) — will delete ${presentKeys.join(", ")}. Manual remainder afterwards per ZOOM.md § Retirement (deactivate legacy app, promote webhook secret, republish).`,
    };
  },
  async apply(actorId) {
    const gate = await zoomLegacyRetirementGate();
    if (!gate.ok) {
      return { state: "blocked", detail: gate.detail };
    }
    const result = await retireLegacyZoomOauthTokens(actorId ?? null);
    if (result.cleared.length === 0) {
      return { state: "not-needed", detail: "Legacy token rows already absent." };
    }
    return {
      state: "applied",
      detail: `Deleted ${result.cleared.join(", ")}${
        result.alreadyAbsent.length > 0
          ? ` (${result.alreadyAbsent.join(", ")} already absent)`
          : ""
      }. Now finish the manual remainder (ZOOM.md § Retirement): deactivate the legacy user-level Marketplace app (never delete; never the in-app disconnect route), move the S2S Secret Token into ZOOM_WEBHOOK_SECRET_TOKEN, unset ZOOM_S2S_WEBHOOK_SECRET_TOKEN, republish.`,
      rowsAffected: result.cleared.length,
    };
  },
};


// Task #4019 (follow-up) — emergency rollback lever for the Zoom S2S
// cutover, requested as a CEO button instead of the route-only fallback.
// Deliberately a MANUAL LEVER (`manualLever: true`): a pending rollback
// under Apply-all would bounce zoom_auth_mode straight back on every
// routine press (the flip action + rollback action would oscillate), so
// the Apply-all pass skips it and only its dedicated per-action endpoint
// fires it. Status is always not-needed — the lever is availability, not
// "work to do" (keeps the panel badge at zero during a healthy soak);
// the button stays visible in the panel's Manual levers section.
export const zoomS2sRollbackToOauthAction: ProdAction = {
  id: "zoom_s2s_rollback_to_oauth",
  // Manual break-glass lever: status is always not-needed (availability,
  // not work), so it can never feed the badge — converging by construction.
  convergence: { kind: "converging" },
  title: "Roll back Zoom to legacy OAuth (emergency lever)",
  description:
    "ZOOM.md § Rollback as one press: flips zoom_auth_mode from s2s back to oauth (the legacy user-level app) via the same shared helper the cutover uses — deliberately NO preflight (rollback must work exactly when S2S is broken); status-cache invalidation and an auto-sync kick are included. Expect one operator reconnect afterward (Integrations Hub → Zoom): the legacy refresh chain lapses after ~1h unused, and once the retirement action has cleared the legacy token rows a reconnect is REQUIRED rather than merely likely. After a rollback the S2S flip action parks itself (prior-successful-run guard) — re-cutover is deliberately route-only (POST /api/integrations/zoom/auth-mode) so a routine Apply-all can never re-flip mid-incident.",
  change:
    "Set zoom_auth_mode = oauth (system_settings; actor recorded). No token rows are touched.",
  manualLever: true,
  async status() {
    const mode = await getZoomAuthMode();
    if (mode !== "s2s") {
      return {
        state: "not-needed",
        detail:
          "Zoom already runs the legacy user-level OAuth app — nothing to roll back.",
      };
    }
    let retiredCount = 0;
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) {
      const row = await storage.getSystemSetting(key);
      if (!row || row.value == null || row.value === "") retiredCount++;
    }
    const tokensRetired =
      retiredCount === ZOOM_LEGACY_TOKEN_SETTING_KEYS.length;
    return {
      state: "not-needed",
      detail:
        "S2S is live. Emergency lever (excluded from Apply-all): one press flips Zoom back to the legacy OAuth app. Expect one operator reconnect afterward" +
        (tokensRetired
          ? " — the legacy token rows are already retired, so the reconnect is REQUIRED before Zoom works again."
          : " (the legacy refresh chain lapses after ~1h unused)."),
    };
  },
  // Task #4762 — served-purpose probe: once S2S is live AND the legacy
  // token rows are fully retired, a rollback press could never restore a
  // working legacy app (an operator reconnect would be required anyway),
  // so the emergency lever's purpose is served and it retires to History
  // instead of sitting in the lever list forever. If mode ever leaves
  // s2s the probe reads not-served again and the lever resurfaces.
  async servedPurpose() {
    const mode = await getZoomAuthMode();
    if (mode !== "s2s") return { served: false };
    let retiredCount = 0;
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) {
      const row = await storage.getSystemSetting(key);
      if (!row || row.value == null || row.value === "") retiredCount++;
    }
    const served = retiredCount === ZOOM_LEGACY_TOKEN_SETTING_KEYS.length;
    return {
      served,
      note: served
        ? "S2S is live and all legacy OAuth token rows are retired — rolling back to the legacy app is no longer possible without a full reconnect, so the emergency lever has served its purpose."
        : undefined,
    };
  },
  async apply(actorId) {
    const result = await applyZoomAuthModeChange("oauth", {
      actorId: actorId ?? null,
    });
    if (result.kind === "unchanged") {
      return {
        state: "not-needed",
        detail: "zoom_auth_mode is already oauth — nothing rolled back.",
      };
    }
    if (result.kind === "not_ready") {
      // Unreachable: the preflight gate only guards the s2s direction.
      // Kept for exhaustiveness so a future helper change fails loudly.
      return {
        state: "error",
        detail: "Unexpected preflight gate on the oauth rollback direction.",
      };
    }
    let retiredCount = 0;
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) {
      const row = await storage.getSystemSetting(key);
      if (!row || row.value == null || row.value === "") retiredCount++;
    }
    const tokensRetired =
      retiredCount === ZOOM_LEGACY_TOKEN_SETTING_KEYS.length;
    return {
      state: "applied",
      detail:
        "zoom_auth_mode flipped s2s → oauth; the legacy user-level OAuth app is live again. The S2S flip action now parks itself — re-cutover is route-only per ZOOM.md § Staged cutover. " +
        (tokensRetired
          ? "The legacy token rows were already retired, so an operator reconnect (Integrations Hub → Zoom) is REQUIRED before Zoom works."
          : "If Zoom jobs report auth errors, one operator reconnect (Integrations Hub → Zoom) refreshes the legacy chain."),
    };
  },
};


export const zoomRematchUnmatchedBacklogAction: ProdAction = {
  id: "zoom_rematch_unmatched_backlog",
  // Historical-backlog mop-up (mirrors rematch_unmatched_front_backlog):
  // new recordings are matched at ingest by the same resolver, so this
  // settles once pressed; it only re-arms when an operator deliberately
  // seeds client email domains or fixes firm names.
  convergence: { kind: "converging" },
  title: "Re-match unmatched Zoom backlog (deterministic)",
  description:
    "Re-runs deterministic Zoom client matching — booked/scheduled-meeting links, strong participant signals, trusted email domains (client emailDomains), and unambiguous topic ↔ firm-name hits — across raw Zoom communication records still unmatched in the last 90 days (the backlog that accumulated while only booked-link/participant matching existed, i.e. why Zoom calls never reached churn analysis). Auto-matches stamp the raw record + client link, drop the superseded Meeting Review item (status='superseded_auto_match'), and enqueue the standard analyze_communication job so the churn AI studies the call. Ambiguous evidence (shared domains, multi-firm topics, person-named topics, conflicting tiers) lands in Meeting Review with the suggested client stored for one-click confirmation; operator-dismissed records are never resurrected. Idempotent and convergent — safe to run again after seeding client email domains or fixing firm names; a follow-up run reports autoMatched=0 when nothing is left to claim.",
  change:
    "Re-run resolveZoomClientMatch over raw_communication_records WHERE source_type='zoom' AND client_id IS NULL AND match_status='unmatched' AND timestamp >= now()-90d (matchMethod 'dismissed%' excluded); matches → matched + communication_client_links upsert + analyze_communication enqueue + open review decisions superseded; ambiguous → review_required sentinel + stored suggestion; no candidate → ensure a review row exists.",
  manualLever: true,
  async status() {
    const { countZoomUnmatchedRematchCandidates } = await import(
      "../zoomReviewQueueBackfill"
    );
    const count = await withDbAttribution(
      "maintenance:prod-actions-zoom-rematch-estimate",
      () => countZoomUnmatchedRematchCandidates(90),
    );
    // Manual lever: ALWAYS not-needed — the candidate count is
    // informational, never a pending-work claim (CEO badge stays zero).
    return {
      state: "not-needed",
      detail:
        count === 0
          ? "No unmatched Zoom records in the 90-day window. Manual lever — press it after seeding client email domains or editing firm names."
          : `${count} unmatched Zoom record(s) in the 90-day window would be re-evaluated against the deterministic tiers. Manual lever — Apply-all never fires it; press after seeding client email domains or editing firm names. Ambiguous evidence lands in Meeting Review with a stored suggestion.`,
    };
  },
  async apply() {
    const { runZoomUnmatchedRematchBackfill, formatZoomUnmatchedRematchReport } =
      await import("../zoomReviewQueueBackfill");
    const report = await runZoomUnmatchedRematchBackfill({
      windowDays: 90,
      dryRun: false,
    });
    return {
      state: "applied",
      detail: formatZoomUnmatchedRematchReport(report),
      rowsAffected: report.autoMatched,
    };
  },
};

// ─── Inline PROD_ACTIONS entries hoisted to named consts (F7) ────────
// These were inline `killSwitchAction({...})` / object-literal entries in
// the monolithic PROD_ACTIONS array; hoisting is argument-verbatim so the
// composition root can reference them by name.

export const drainStaleZoomApplyEventsAction: ProdAction = {
  id: "drain_stale_zoom_apply_events",
  convergence: { kind: "converging" },
  // Task #4762 drain declaration:
  humanGate: {
    reason:
      "The nightly Zoom reconciliation runs this same stale-event sweep automatically; the press is an immediate-drain shortcut and each pass burns attempt budget — a human decides when to spend it early.",
  },
  title: "Drain stale Zoom apply events (stuck ready_to_apply)",
  description:
    "Task #3699 — re-drives Zoom recording_completed / transcript_completed source events stuck pre-apply (received / normalized / ready_to_apply) for more than 6 hours. Each pass increments the event-level attempt counter and re-enqueues the matching zoom_meeting_apply / zoom_transcript_apply job (idempotent — meetings/transcripts already applied short-circuit as skipped, which now also marks the event applied). Events whose retry budget (max_attempts, default 5) is exhausted, or whose recording Zoom has since deleted, are terminally closed with a stored reason instead of retrying forever. Bounded to 500 events per press. The nightly Zoom reconciliation runs the same sweep automatically; this button is the on-demand drain for the existing backlog.",
  change:
    "UPDATE stale zoom source_event_log rows (attempt_count+1 and re-enqueue apply job, or status='failed' with errorCode when retries are exhausted); enqueue zoom_meeting_apply / zoom_transcript_apply work_queue rows (workload_class=ingestion).",
  async status() {
    const lastRun = await getLastSuccessfulProdActionRun(
      "drain_stale_zoom_apply_events",
    );
    if (lastRun?.appliedAt) {
      const ageMs = Date.now() - new Date(lastRun.appliedAt).getTime();
      if (ageMs >= 0 && ageMs < 2 * 60_000) {
        return {
          state: "not-needed",
          detail: `Recently drained ${Math.floor(ageMs / 1000)}s ago — re-enqueued apply jobs are still working through the queue. The nightly reconciliation sweep re-checks automatically; this button becomes available again after a 2-minute cooldown.`,
        };
      }
    }
    const { countStaleZoomApplyEvents } = await import(
      "../zoomStaleApplyEventSweep"
    );
    const stale = await countStaleZoomApplyEvents();
    if (stale === 0) {
      return {
        state: "not-needed",
        detail:
          "No Zoom apply events are stuck pre-apply past the 6h staleness threshold.",
      };
    }
    return {
      state: "pending",
      detail: `${stale} Zoom apply event(s) stuck pre-apply >6h. Press to re-drive them (bounded retries) and terminally close exhausted ones.`,
    };
  },
  async apply() {
    const { sweepStaleZoomApplyEvents, ZOOM_APPLY_SWEEP_LIMIT } = await import(
      "../zoomStaleApplyEventSweep"
    );
    // One-and-done (Task #1969): loop bounded chunks until the stale
    // cohort is empty. Converges in a single press because every
    // requeued event's updated_at is stamped `now` (it leaves the
    // stale cohort immediately) and exhausted events are terminally
    // closed — each chunk strictly shrinks the cohort. Hard cap keeps
    // a pathological backlog bounded (~10k events).
    let scanned = 0;
    let requeued = 0;
    let terminal = 0;
    const errors: string[] = [];
    for (let chunk = 0; chunk < 20; chunk++) {
      const r = await sweepStaleZoomApplyEvents({ skipAlert: true });
      scanned += r.scanned;
      requeued += r.requeued;
      terminal += r.terminal;
      errors.push(...r.errors);
      if (r.scanned < ZOOM_APPLY_SWEEP_LIMIT) break;
    }
    if (scanned === 0) {
      return {
        state: "not-needed",
        detail: "No stale Zoom apply events found.",
      };
    }
    const errSuffix =
      errors.length > 0
        ? ` Errors on ${errors.length} event(s): ${errors.slice(0, 3).join("; ")}`
        : "";
    return {
      state: "applied",
      detail: `Drained ${scanned} stale event(s): re-enqueued ${requeued} apply job(s) (idempotent — already-applied work skips), terminally closed ${terminal} with a stored reason.${errSuffix} Re-enqueued jobs finish asynchronously in the work queue; the nightly sweep keeps watching for recurrences.`,
    };
  },
};

// ─── Domain collection (F7) ──────────────────────────────────────────
// Membership list for the composition-root guard: every registry action
// this module defines. Operator-facing order lives in ./composition.ts.
export const zoomDomain: ProdActionDomain = {
  name: "zoom",
  actions: [
    drainStaleZoomApplyEventsAction,
    zoomS2sCutoverAction,
    retireLegacyZoomOauthTokensAction,
    zoomS2sRollbackToOauthAction,
    zoomRematchUnmatchedBacklogAction,
  ],
};
