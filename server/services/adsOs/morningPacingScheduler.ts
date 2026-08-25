// @db-pool-intent: worker
//
// Ads OS (rebuild) — morning budget-pacing refresh scheduler. Spec §10: an
// internal ~6am ET daily job that re-runs budget pacing for every ENROLLED
// account (both products, incl. Off) and persists each summary, so the
// dashboard pacing columns are accurate every morning. Invokes the SAME code
// path as POST /api/ads-os/cron/refresh-pacing (external scheduler variant).
//
// This scheduler feeds the /ads-os stores and has its own kill switch
// so the two systems can be cut over independently.
//
// Lifecycle mirrors the deployment-gated cross-instance-singleton schedulers
// (appBackupScheduler):
//   1. Default OFF: gated behind the `ads_os_pacing_refresh_enabled` system
//      setting (kill switch) checked live at every tick.
//   2. Deployment-gated: only the deployed app runs it. Set
//      ADS_OS_PACING_REFRESH_FORCE_ENABLE=1 to run locally (tests).
//   3. Cross-instance singleton: each run takes a cluster-wide Postgres
//      advisory lock so exactly ONE autoscale instance refreshes per morning
//      (the lock self-heals when the holder crashes).
//   4. Worker pool: all DB work runs via runWithWorkerDb.
//
// Once-per-day semantics: ticks every 15 min; runs when the America/New_York
// hour reaches MORNING_HOUR_ET and the last completed run wasn't already
// today (persisted in `system_settings` so a restart can't double-run).
//
// Phase 6 extends the run body with alerts + the Slack digest + ClickUp
// reconcile; pacing-scope only for now.

import { runWithWorkerDb, withDbAttribution } from "../../db";
import { withWorkerSingletonLock } from "../crossInstanceLock";
import { isRunningInDeployment } from "../../lib/deploymentEnv";
import { getSystemSetting, setSystemSetting } from "../../storage/settingsStorage";

const ENABLED_SETTING = "ads_os_pacing_refresh_enabled";
const LAST_RUN_SETTING = "ads_os_pacing_refresh_last_run_date";
const SINGLETON_KEY = "ads_os_pacing_refresh";
const TICK_INTERVAL_MS = 15 * 60 * 1000;
const MORNING_HOUR_ET = 6;

let scheduler: ReturnType<typeof setInterval> | null = null;
let running = false;

function isForceEnabled(): boolean {
  const v = process.env.ADS_OS_PACING_REFRESH_FORCE_ENABLE;
  return v === "1" || v === "true";
}

function etToday(now = new Date()): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
  };
}

async function isEnabled(): Promise<boolean> {
  try {
    const s = await getSystemSetting(ENABLED_SETTING);
    return s?.value === "true"; // default OFF
  } catch {
    return false;
  }
}

/** The refresh body — the same code path as the cron endpoint. Exported for
 *  tests / manual invocation. */
export async function runAdsOsPacingRefresh(): Promise<{
  gads: { requested: number; ran: number };
  lsa: { requested: number; ran: number };
  alerts: import("./alertsEngine").RunAlertsSummary;
  status_checks: Record<string, any>;
}> {
  const [{ refreshAllPacing }, { refreshAllLsaPacing }, { runAlerts }, { runStatusChecks }] =
    await Promise.all([
      import("./pacingEngine"),
      import("./lsaPacingEngine"),
      import("./alertsEngine"),
      import("./statusCheck"),
    ]);
  // AM Dashboard (Task #3988): verify every ClickUp-paused/off account against
  // its real state (the ✓/✗ on the Paused/Off chips) FIRST — it's the cheapest
  // phase here (~a dozen accounts, one query each) and the only one that
  // persists a single document at the end, so anywhere later in this job it
  // would be the first casualty of a slow morning while pacing and alerts —
  // which persist per account — would already have banked most of theirs. It
  // warms the ClickUp directory the later phases need anyway. Best-effort: a
  // failure must not sink the job the dashboards depend on.
  let status_checks: Record<string, any>;
  try {
    status_checks = await runStatusChecks();
  } catch (err: any) {
    status_checks = { error: String(err?.constructor?.name || err?.name || "Error") };
  }
  const gads = await refreshAllPacing();
  const lsa = await refreshAllLsaPacing();
  // Phase 6: compute account alerts (GAds + LSA) with fresh pacing in hand,
  // persist them for the dashboard badges, reconcile open ClickUp tickets, and
  // send the only-on-change Slack digest. Rides the same morning job — no
  // separate scheduler or cron secret.
  const alerts = await runAlerts(true);
  // A verification that computed but couldn't persist is invisible in the UI
  // (bare chips look exactly like a check that never ran) — log it loudly; the
  // done-line below only carries counts.
  if (status_checks.saved === false || status_checks.error) {
    console.error(
      "[AdsOsV2] morning run: status checks not persisted:",
      JSON.stringify(status_checks),
    );
  }
  return { gads, lsa, alerts, status_checks };
}

async function tick(): Promise<void> {
  if (running) return; // never overlap a slow run
  running = true;
  try {
    if (!(await isEnabled())) return;
    const { date, hour } = etToday();
    if (hour < MORNING_HOUR_ET) return;

    await withWorkerSingletonLock(SINGLETON_KEY, async () => {
      // Re-check inside the lock: another instance may have run already.
      const last = await getSystemSetting(LAST_RUN_SETTING);
      if (last?.value === date) return;

      console.log("[AdsOsV2] Morning pacing refresh starting (GAds + LSA)");
      const result = await runWithWorkerDb(() =>
        withDbAttribution("scheduler:ads-os-pacing-refresh", () => runAdsOsPacingRefresh()),
      );
      await setSystemSetting(LAST_RUN_SETTING, date);
      const sc = result.status_checks;
      const scLine = sc.skipped
        ? `status checks skipped (${sc.skipped})`
        : sc.error
          ? `status checks failed (${sc.error})`
          : `status checks ${sc.checked ?? 0} (${sc.mismatches ?? 0} mismatches, saved=${sc.saved})`;
      console.log(
        `[AdsOsV2] Morning pacing refresh done: gads ${result.gads.ran}/${result.gads.requested}, ` +
          `lsa ${result.lsa.ran}/${result.lsa.requested}, alerts ${result.alerts.total_alerts} ` +
          `across ${result.alerts.gads_accounts + result.alerts.lsa_accounts} accounts` +
          (result.alerts.digest?.sent ? ` (digest: ${result.alerts.digest.new_alerts} new)` : "") +
          `, ${scLine}`,
      );
    });
  } catch (err: any) {
    console.error("[AdsOsV2] Morning pacing refresh tick failed:", err?.message ?? err);
  } finally {
    running = false;
  }
}

export function startAdsOsPacingRefreshScheduler(): void {
  if (scheduler) return;
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[AdsOsV2] Morning pacing refresh scheduler not started (workspace) — deployment owns it. " +
        "Set ADS_OS_PACING_REFRESH_FORCE_ENABLE=1 to run locally.",
    );
    return;
  }
  // @lint-cross-instance-locks: tick body runs under withWorkerSingletonLock
  scheduler = setInterval(() => void tick(), TICK_INTERVAL_MS);
  console.log(
    `[AdsOsV2] Morning pacing refresh scheduler started (tick every ${TICK_INTERVAL_MS / 60000} min, ` +
      `runs after ${MORNING_HOUR_ET}:00 ET when '${ENABLED_SETTING}'=true)`,
  );
}

export function stopAdsOsPacingRefreshScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
}
