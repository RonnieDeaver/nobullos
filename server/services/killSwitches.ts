/**
 * Task #836 Phase 2 (post-review): Hot-toggleable kill switches.
 *
 * Why: the original Phase 2 implementation read kill switches directly
 * from `PERF.KILL_SWITCH_*` (env vars resolved at process start),
 * which meant flipping a switch required a restart or redeploy. The
 * code reviewer correctly flagged this as not meeting the "abort
 * expensive background work without deploy" requirement.
 *
 * This module sits between the consumer and `PERF`:
 *
 *   consumer  →  isKillSwitchEnabled(name)
 *                  ↓
 *                in-memory override  (set by the admin endpoint;
 *                                    persisted to system_settings as
 *                                    `kill_switch_<name>` keys)
 *                  ↓ (if no override)
 *                PERF.KILL_SWITCH_<NAME>  (env-var default)
 *
 * Persisted overrides are loaded once on first read so we don't pay a
 * DB round-trip per check; subsequent writes update the in-memory
 * override and the persisted row in the same call.
 */
import { PERF } from "../perfConfig";
import { storage } from "../storage";

export type KillSwitchName =
  | "retroactive_reprocess"
  | "front_sync_reprocess"
  | "auto_retry"
  | "non_critical_sweeps"
  | "large_backfills"
  | "semrush_background_refresh"
  | "semrush_demand_driven_refresh"
  | "semrush_auto_retry_backoff"
  | "semrush_identical_result_apply_suppression"
  | "sheets_auto_refresh_enabled"
  | "sheets_writes_disabled"
  | "zoom_face_sentiment_enabled"
  | "zoom_revai_transcription"
  | "ats_revai_transcription"
  // Workers/queues audit parity (E-F05): operator kill switches for the
  // custom-table worker pipelines that bypass `work_queue`. TRUE = the
  // worker stops claiming NEW work (in-flight items finish or stop at the
  // next safe batch boundary). Default OFF so workers run unless an
  // operator engages the switch.
  | "call_analysis"
  | "call_archive"
  | "local_dominance_sync"
  // Task #5097 — book-commerce payment processing pause lever. When engaged,
  // verified supported Stripe book events are still durably dispatched to
  // storage (for receipt/reconciliation) but with effectsPaused=true so
  // fulfilment, order creation, and entitlement side-effects are skipped.
  // Generic stripe-replit-sync processing is always unaffected.
  | "book_payment_processing"
  // Pauses outbound CRM mirroring only. It does not alter the authoritative
  // book-commerce transaction, payment, consent, or entitlement paths.
  | "ghl_outbound_sync"
  // Task #5156 — pauses ClickUp role projection command draining (pending commands
  // accumulate but are not dispatched). Assignment writes and NoBull-only roles
  // are unaffected. When released, safe-kick drains pending commands.
  | "clickup_role_projection";

export const KILL_SWITCH_NAMES: KillSwitchName[] = [
  "retroactive_reprocess",
  "front_sync_reprocess",
  "auto_retry",
  "non_critical_sweeps",
  "large_backfills",
  "semrush_background_refresh",
  "semrush_demand_driven_refresh",
  "semrush_auto_retry_backoff",
  "semrush_identical_result_apply_suppression",
  "sheets_auto_refresh_enabled",
  "sheets_writes_disabled",
  "zoom_face_sentiment_enabled",
  "zoom_revai_transcription",
  "ats_revai_transcription",
  "call_analysis",
  "call_archive",
  "local_dominance_sync",
  "book_payment_processing",
  "ghl_outbound_sync",
  "clickup_role_projection",
];

const SETTING_PREFIX = "kill_switch_";

const overrides = new Map<KillSwitchName, boolean>();
let loaded = false;
let loadingPromise: Promise<void> | null = null;

function envDefault(name: KillSwitchName): boolean {
  switch (name) {
    case "retroactive_reprocess": return PERF.KILL_SWITCH_RETROACTIVE_REPROCESS;
    case "front_sync_reprocess": return PERF.KILL_SWITCH_FRONT_SYNC_REPROCESS;
    case "auto_retry": return PERF.KILL_SWITCH_AUTO_RETRY;
    case "non_critical_sweeps": return PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;
    case "large_backfills": return PERF.KILL_SWITCH_LARGE_BACKFILLS;
    case "semrush_background_refresh": return PERF.KILL_SWITCH_SEMRUSH_BACKGROUND_REFRESH;
    // Task #1785: these three are "feature-enabled" switches, persisted
    // as `system_settings` keys with the SAME name (no `kill_switch_`
    // prefix) for operator readability. We model them through this same
    // module so the snapshot endpoint can show a unified view; the
    // semantics are inverted (TRUE = feature on), matching the PERF
    // defaults. The `setSemrushCadenceFeatureFlag` helper below writes
    // the cleanly-named setting key.
    case "semrush_demand_driven_refresh": return PERF.SEMRUSH_DEMAND_DRIVEN_REFRESH_ENABLED;
    case "semrush_auto_retry_backoff": return PERF.SEMRUSH_AUTO_RETRY_BACKOFF_ENABLED;
    case "semrush_identical_result_apply_suppression": return PERF.SEMRUSH_IDENTICAL_RESULT_APPLY_SUPPRESSION_ENABLED;
    case "sheets_auto_refresh_enabled": return false;
    // Incident-response lever: disable all Sheets write endpoints while
    // leaving read operations (library list, workbook load, lock poll) up.
    // Default OFF so writes are always allowed unless explicitly engaged.
    case "sheets_writes_disabled": return false;
    // Task #3702 — opt-in "feature-enabled" switch (TRUE = feature on, like
    // sheets_auto_refresh_enabled): background client face-sentiment analysis
    // of Zoom meeting videos. Default OFF — vision analysis of recordings
    // costs real tokens and must be deliberately enabled by an operator.
    case "zoom_face_sentiment_enabled": return false;
    // Task #3701: pause Rev AI transcript generation for Zoom recordings
    // (enqueue, revival AND job submission — Rev AI bills per audio minute).
    // While engaged, the sweep parks past-window audio-bearing records as
    // terminal `no_transcript_after_window` exactly like Task #3689, which
    // keeps them revivable once the switch is released.
    case "zoom_revai_transcription": return PERF.KILL_SWITCH_ZOOM_REVAI_TRANSCRIPTION;
    // Task #3963 (audit B-012): pause the ATS video-submission Rev AI
    // transcription pipeline (new submissions stay 'pending' un-submitted;
    // the fallback sweeper no-ops). The authenticated callback route stays
    // live so jobs already submitted — and billed — still record their
    // outcome. Parked rows are re-driven by the existing ATS retry
    // endpoints once the switch is released.
    case "ats_revai_transcription": return PERF.KILL_SWITCH_ATS_REVAI_TRANSCRIPTION;
    // Workers/queues audit parity (E-F05): no PERF env-var defaults on
    // purpose — these are incident-response levers toggled at runtime via
    // the admin endpoint (`kill_switch_<name>` system_settings overrides).
    // Default OFF = worker enabled.
    case "call_analysis": return false;
    case "call_archive": return false;
    case "local_dominance_sync": return false;
    // Task #5097 — default false (processing active); operator toggles to pause.
    case "book_payment_processing": return false;
    case "ghl_outbound_sync": return false;
    // Task #5156 — default false (projection active); operator toggles to pause.
    case "clickup_role_projection": return false;
  }
}

async function loadOverrides(): Promise<void> {
  if (loaded) return;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const keys = KILL_SWITCH_NAMES.map((n) => `${SETTING_PREFIX}${n}`);
      const rows = await storage.getSystemSettings(keys);
      for (const name of KILL_SWITCH_NAMES) {
        const raw = rows[`${SETTING_PREFIX}${name}`];
        if (raw === "true") overrides.set(name, true);
        else if (raw === "false") overrides.set(name, false);
      }
      loaded = true;
    } catch (err: any) {
      // Fail-safe: if the load fails we fall back to env defaults.
      // We do NOT mark loaded=true so a later read will retry.
      console.warn("[KillSwitches] Failed to load overrides:", err?.message ?? err);
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

/**
 * Synchronous read used on hot paths. The very first call returns the
 * env default; an async load is kicked off in the background so
 * subsequent calls see persisted overrides. Handlers that absolutely
 * need a fresh value should `await ensureKillSwitchesLoaded()` before
 * checking — see `getKillSwitchSnapshot()` and the admin endpoint.
 */
export function isKillSwitchEnabled(name: KillSwitchName): boolean {
  if (!loaded && !loadingPromise) {
    void loadOverrides();
  }
  const override = overrides.get(name);
  return override ?? envDefault(name);
}

export async function ensureKillSwitchesLoaded(): Promise<void> {
  if (loaded) return;
  await loadOverrides();
}

export async function setKillSwitch(
  name: KillSwitchName,
  value: boolean,
  updatedBy?: string,
): Promise<void> {
  await ensureKillSwitchesLoaded();
  overrides.set(name, value);
  if (name === "book_payment_processing" && value === false) {
    void import("./bookPaymentEventReplay")
      .then(({ startBookPaymentEventReplay }) => {
        startBookPaymentEventReplay("switch_release");
      })
      .catch((err) => {
        console.error("[KillSwitches] Failed to start book-payment replay:", err);
      });
  }
  // Task #5156: on kill-switch release, safe-kick pending projection commands.
  if (name === "clickup_role_projection" && value === false) {
    void import("./clickUpRoleProjectionKick")
      .then(({ kickClickUpRoleProjectionSafe }) => kickClickUpRoleProjectionSafe())
      .catch((err) => {
        console.error("[KillSwitches] Failed to kick ClickUp role projection on release:", err);
      });
  }
  try {
    await storage.setSystemSetting(`${SETTING_PREFIX}${name}`, value ? "true" : "false", updatedBy);
  } catch (err: any) {
    // The in-memory override still takes effect even if persistence
    // fails — operators get an immediate kill at the cost of losing it
    // on the next process restart, which is the right trade in an
    // incident.
    console.warn("[KillSwitches] Failed to persist override:", err?.message ?? err);
    throw err;
  }
}

/**
 * Snapshot used by the dashboard endpoint. Returns the *effective*
 * value (override-or-default) plus the env default and whether an
 * override is currently in force, so operators can see drift at a
 * glance.
 */
export async function getKillSwitchSnapshot(): Promise<
  Record<KillSwitchName, { effective: boolean; envDefault: boolean; overridden: boolean }>
> {
  await ensureKillSwitchesLoaded();
  const out = {} as Record<KillSwitchName, { effective: boolean; envDefault: boolean; overridden: boolean }>;
  for (const name of KILL_SWITCH_NAMES) {
    const env = envDefault(name);
    const override = overrides.get(name);
    out[name] = {
      effective: override ?? env,
      envDefault: env,
      overridden: override !== undefined,
    };
  }
  return out;
}
