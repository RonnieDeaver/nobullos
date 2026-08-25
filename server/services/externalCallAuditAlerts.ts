/**
 * Task #1731 (Pool epic Phase 4, spec 4.4) — External-call audit alert
 * evaluator.
 *
 * Periodic worker that scans the Phase 1.5 audit tables
 * (`external_call_audits`, `external_call_audit_daily_rollups`,
 * `pool_state_samples`) and fires Slack signals via the existing
 * `notifyByType` dispatcher (notification id
 * `infra.usage.external_call_audit_alert` → routed to the queue-health
 * channel) when any of five conditions trip:
 *
 *   1. **Same-response storm** — the same `request_dedupe_key` returned
 *      the same response hash more than `same_response_threshold` times
 *      in the last `same_response_window_minutes` minutes.
 *   2. **Cache-hit drop WoW** — last-7d cache-hit ratio (per
 *      integration) dropped by more than `cache_hit_drop_pct` versus the
 *      prior 7d window. Only fires when both windows have meaningful
 *      volume (`min_calls_for_ratio_alert`).
 *   3. **Calls/min spike** — last-hour calls-per-minute (per
 *      integration) exceeds `rpm_spike_multiplier` × the trailing 7-day
 *      baseline rpm.
 *   4. **Duration spike** — last-hour avg duration (per integration)
 *      exceeds `duration_spike_multiplier` × the trailing 7-day avg.
 *   5. **DB-saturation correlation** — the last-hour external-call
 *      window overlaps with a pool sample where `utilization_pct >=
 *      saturation_pct` more than `saturation_correlation_pct` % of the
 *      time. Catches the "external call storm is what's saturating the
 *      DB pool" pattern.
 *
 * Per-(integration, kind) cooldown via `lastAlertAt` prevents noise; all
 * thresholds live in `system_settings` so operators can tune without a
 * deploy. Each alert links back to `/admin/db-attribution/trends`.
 *
 * Gated by `external_call_audit_enabled` (Phase 0 switch). When OFF the
 * tick returns an empty result without touching the DB.
 */
import { sql } from "drizzle-orm";
import { workerDb, withDbAttribution, runWithWorkerDb } from "../db";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";
import { getSystemSetting } from "../storage/settingsStorage";

export const NOTIFICATION_ID = "infra.usage.external_call_audit_alert";

export const SETTING_ENABLED = "external_call_alert_enabled";
export const SETTING_SAME_RESPONSE_THRESHOLD = "external_call_alert_same_response_threshold";
export const SETTING_SAME_RESPONSE_WINDOW_MIN = "external_call_alert_same_response_window_minutes";
export const SETTING_CACHE_HIT_DROP_PCT = "external_call_alert_cache_hit_drop_pct";
export const SETTING_MIN_CALLS_FOR_RATIO = "external_call_alert_min_calls_for_ratio";
export const SETTING_RPM_SPIKE_MULT = "external_call_alert_rpm_spike_multiplier";
export const SETTING_DURATION_SPIKE_MULT = "external_call_alert_duration_spike_multiplier";
export const SETTING_SATURATION_PCT = "external_call_alert_saturation_pct";
export const SETTING_SATURATION_CORRELATION_PCT = "external_call_alert_saturation_correlation_pct";
export const SETTING_COOLDOWN_MINUTES = "external_call_alert_cooldown_minutes";

export const DEFAULTS = {
  enabled: true,
  sameResponseThreshold: 50,
  sameResponseWindowMinutes: 60,
  cacheHitDropPct: 25,
  minCallsForRatio: 200,
  rpmSpikeMultiplier: 5,
  durationSpikeMultiplier: 3,
  saturationPct: 80,
  saturationCorrelationPct: 50,
  cooldownMinutes: 30,
};

export type AlertKind =
  | "same_response_storm"
  | "cache_hit_drop"
  | "rpm_spike"
  | "duration_spike"
  | "db_saturation_correlation";

export interface ActiveAlert {
  kind: AlertKind;
  integration: string;
  message: string;
  metric: Record<string, unknown>;
  firedAt: number;
}

const CHECK_INTERVAL_MS = 5 * 60_000;

const activeAlerts: ActiveAlert[] = [];
const lastAlertAt = new Map<string, number>();

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let killSwitchOverride: (() => boolean) | null = null;

function parsePositiveNumber(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export interface AlertConfig {
  enabled: boolean;
  sameResponseThreshold: number;
  sameResponseWindowMinutes: number;
  cacheHitDropPct: number;
  minCallsForRatio: number;
  rpmSpikeMultiplier: number;
  durationSpikeMultiplier: number;
  saturationPct: number;
  saturationCorrelationPct: number;
  cooldownMinutes: number;
}

export async function getAlertConfig(): Promise<AlertConfig> {
  const get = (k: string) => getSystemSetting(k).catch(() => null);
  const [en, srT, srW, chD, mc, rpmM, durM, satP, satC, cd] = await Promise.all([
    get(SETTING_ENABLED),
    get(SETTING_SAME_RESPONSE_THRESHOLD),
    get(SETTING_SAME_RESPONSE_WINDOW_MIN),
    get(SETTING_CACHE_HIT_DROP_PCT),
    get(SETTING_MIN_CALLS_FOR_RATIO),
    get(SETTING_RPM_SPIKE_MULT),
    get(SETTING_DURATION_SPIKE_MULT),
    get(SETTING_SATURATION_PCT),
    get(SETTING_SATURATION_CORRELATION_PCT),
    get(SETTING_COOLDOWN_MINUTES),
  ]);
  return {
    enabled: parseBool(en?.value, DEFAULTS.enabled),
    sameResponseThreshold: parsePositiveNumber(srT?.value, DEFAULTS.sameResponseThreshold),
    sameResponseWindowMinutes: parsePositiveNumber(srW?.value, DEFAULTS.sameResponseWindowMinutes),
    cacheHitDropPct: parsePositiveNumber(chD?.value, DEFAULTS.cacheHitDropPct),
    minCallsForRatio: parsePositiveNumber(mc?.value, DEFAULTS.minCallsForRatio),
    rpmSpikeMultiplier: parsePositiveNumber(rpmM?.value, DEFAULTS.rpmSpikeMultiplier),
    durationSpikeMultiplier: parsePositiveNumber(durM?.value, DEFAULTS.durationSpikeMultiplier),
    saturationPct: parsePositiveNumber(satP?.value, DEFAULTS.saturationPct),
    saturationCorrelationPct: parsePositiveNumber(satC?.value, DEFAULTS.saturationCorrelationPct),
    cooldownMinutes: parsePositiveNumber(cd?.value, DEFAULTS.cooldownMinutes),
  };
}

function killSwitchEnabled(): boolean {
  if (killSwitchOverride) return killSwitchOverride();
  return isPoolEpicSwitchEnabled("external_call_audit_enabled");
}

function buildLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  return `${base.replace(/\/$/, "")}/admin/db-attribution/trends`;
}

function utcDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function rows<T = any>(q: any): Promise<T[]> {
  const r = await q;
  return (Array.isArray(r) ? r : (r as any).rows ?? []) as T[];
}

async function dispatch(
  alert: ActiveAlert,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const text = `${alert.message}\n• Trends panel: ${buildLink()}`;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata: {
          kind: alert.kind,
          integration: alert.integration,
          firedAt: alert.firedAt,
          ...alert.metric,
        },
      },
    );
    return {
      delivered: r.delivered,
      skipReason: r.delivered ? undefined : (r.skipReason ?? r.status),
    };
  } catch (err: any) {
    return { delivered: false, skipReason: `dispatch_error:${err?.message ?? "unknown"}` };
  }
}

function trackAndCooldown(alert: ActiveAlert, cooldownMs: number, now: number): boolean {
  const key = `${alert.kind}|${alert.integration}`;
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  lastAlertAt.set(key, now);
  activeAlerts.push(alert);
  // Bound the in-memory active-alert buffer so the trends panel never
  // unbounded-grows during a long incident.
  if (activeAlerts.length > 200) {
    activeAlerts.splice(0, activeAlerts.length - 200);
  }
  return true;
}

export interface EvaluationResult {
  evaluatedAt: number;
  enabled: boolean;
  killSwitchEnabled: boolean;
  alertsFired: number;
  alerts: ActiveAlert[];
}

export async function evaluateExternalCallAlerts(
  now: number = Date.now(),
): Promise<EvaluationResult> {
  const result: EvaluationResult = {
    evaluatedAt: now,
    enabled: false,
    killSwitchEnabled: killSwitchEnabled(),
    alertsFired: 0,
    alerts: [],
  };
  if (!result.killSwitchEnabled) return result;

  const config = await getAlertConfig();
  result.enabled = config.enabled;
  if (!config.enabled) return result;

  const cooldownMs = config.cooldownMinutes * 60_000;
  const last1hStart = now - 60 * 60_000;
  const sameResponseWindowStart = now - config.sameResponseWindowMinutes * 60_000;
  const last7dStart = now - 7 * 24 * 60 * 60_000;
  const prev7dStart = now - 14 * 24 * 60 * 60_000;
  const today = utcDate(now);
  const sevenDaysAgo = utcDate(now - 7 * 24 * 60 * 60_000);
  const fourteenDaysAgo = utcDate(now - 14 * 24 * 60 * 60_000);

  // ── Rule 1: Same-response storm ────────────────────────────────────
  const sameResponseHits = await rows<{
    integration: string;
    request_dedupe_key: string;
    same_response_count: number;
    total_count: number;
    sample_endpoint: string;
  }>(
    workerDb.execute(sql`
      SELECT integration,
             request_dedupe_key,
             COUNT(*) FILTER (WHERE same_response_as_previous)::int AS same_response_count,
             COUNT(*)::int AS total_count,
             MAX(endpoint) AS sample_endpoint
      FROM external_call_audits
      WHERE called_at >= ${sameResponseWindowStart}
      GROUP BY integration, request_dedupe_key
      HAVING COUNT(*) FILTER (WHERE same_response_as_previous) >= ${config.sameResponseThreshold}
      ORDER BY same_response_count DESC
      LIMIT 25
    `),
  );
  for (const hit of sameResponseHits) {
    const alert: ActiveAlert = {
      kind: "same_response_storm",
      integration: hit.integration,
      message: `:warning: *External-call same-response storm* — \`${hit.integration}\` returned an identical response ${hit.same_response_count} times in ${config.sameResponseWindowMinutes}m (endpoint \`${hit.sample_endpoint}\`). Likely missing caching or a hot polling loop.`,
      metric: {
        sameResponseCount: hit.same_response_count,
        totalCount: hit.total_count,
        windowMinutes: config.sameResponseWindowMinutes,
        endpoint: hit.sample_endpoint,
      },
      firedAt: now,
    };
    if (trackAndCooldown(alert, cooldownMs, now)) {
      await dispatch(alert);
      result.alerts.push(alert);
      result.alertsFired += 1;
    }
  }

  // ── Rule 2: Cache-hit ratio drop WoW ───────────────────────────────
  const cacheHitWow = await rows<{
    integration: string;
    curr_calls: number;
    curr_hits: number;
    prev_calls: number;
    prev_hits: number;
  }>(
    workerDb.execute(sql`
      WITH curr AS (
        SELECT integration,
               SUM(call_count)::int AS calls,
               SUM(cache_hit_count)::int AS hits
        FROM external_call_audit_daily_rollups
        WHERE date >= ${sevenDaysAgo} AND date <= ${today}
        GROUP BY integration
      ),
      prev AS (
        SELECT integration,
               SUM(call_count)::int AS calls,
               SUM(cache_hit_count)::int AS hits
        FROM external_call_audit_daily_rollups
        WHERE date >= ${fourteenDaysAgo} AND date < ${sevenDaysAgo}
        GROUP BY integration
      )
      SELECT COALESCE(curr.integration, prev.integration) AS integration,
             COALESCE(curr.calls, 0) AS curr_calls,
             COALESCE(curr.hits, 0) AS curr_hits,
             COALESCE(prev.calls, 0) AS prev_calls,
             COALESCE(prev.hits, 0) AS prev_hits
      FROM curr FULL OUTER JOIN prev USING (integration)
    `),
  );
  for (const row of cacheHitWow) {
    if (row.curr_calls < config.minCallsForRatio || row.prev_calls < config.minCallsForRatio) continue;
    const currRatio = row.curr_hits / row.curr_calls;
    const prevRatio = row.prev_hits / row.prev_calls;
    if (prevRatio <= 0) continue;
    const dropPct = (prevRatio - currRatio) * 100;
    if (dropPct < config.cacheHitDropPct) continue;
    const alert: ActiveAlert = {
      kind: "cache_hit_drop",
      integration: row.integration,
      message: `:chart_with_downwards_trend: *External-call cache-hit ratio dropped* — \`${row.integration}\` hit ratio fell from ${(prevRatio * 100).toFixed(1)}% to ${(currRatio * 100).toFixed(1)}% week-over-week (Δ ${dropPct.toFixed(1)}pp).`,
      metric: {
        currRatio,
        prevRatio,
        dropPct,
        currCalls: row.curr_calls,
        prevCalls: row.prev_calls,
      },
      firedAt: now,
    };
    if (trackAndCooldown(alert, cooldownMs, now)) {
      await dispatch(alert);
      result.alerts.push(alert);
      result.alertsFired += 1;
    }
  }

  // ── Rule 3 & 4: Calls/min spike + duration spike ───────────────────
  const integrationLastHour = await rows<{
    integration: string;
    calls: number;
    avg_duration_ms: number;
  }>(
    workerDb.execute(sql`
      SELECT integration,
             COUNT(*)::int AS calls,
             COALESCE(AVG(duration_ms), 0)::float AS avg_duration_ms
      FROM external_call_audits
      WHERE called_at >= ${last1hStart}
      GROUP BY integration
    `),
  );
  const baseline7d = await rows<{
    integration: string;
    calls: number;
    avg_duration_ms: number;
  }>(
    workerDb.execute(sql`
      SELECT integration,
             COUNT(*)::int AS calls,
             COALESCE(AVG(duration_ms), 0)::float AS avg_duration_ms
      FROM external_call_audits
      WHERE called_at >= ${last7dStart}
      GROUP BY integration
    `),
  );
  const baselineMap = new Map(baseline7d.map((r) => [r.integration, r]));
  for (const curr of integrationLastHour) {
    const base = baselineMap.get(curr.integration);
    if (!base) continue;
    const currRpm = curr.calls / 60;
    const baseRpm = base.calls / (7 * 24 * 60);
    if (baseRpm > 0 && currRpm > 0 && currRpm >= baseRpm * config.rpmSpikeMultiplier) {
      const alert: ActiveAlert = {
        kind: "rpm_spike",
        integration: curr.integration,
        message: `:zap: *External-call rate spike* — \`${curr.integration}\` last-hour rate ${currRpm.toFixed(1)} calls/min is ${(currRpm / baseRpm).toFixed(1)}× the 7-day baseline (${baseRpm.toFixed(2)} calls/min).`,
        metric: { currRpm, baseRpm, multiplier: currRpm / baseRpm },
        firedAt: now,
      };
      if (trackAndCooldown(alert, cooldownMs, now)) {
        await dispatch(alert);
        result.alerts.push(alert);
        result.alertsFired += 1;
      }
    }
    if (
      base.avg_duration_ms > 0 &&
      curr.avg_duration_ms >= base.avg_duration_ms * config.durationSpikeMultiplier &&
      curr.calls >= 10
    ) {
      const alert: ActiveAlert = {
        kind: "duration_spike",
        integration: curr.integration,
        message: `:hourglass_flowing_sand: *External-call duration spike* — \`${curr.integration}\` last-hour avg ${curr.avg_duration_ms.toFixed(0)}ms is ${(curr.avg_duration_ms / base.avg_duration_ms).toFixed(1)}× the 7-day baseline (${base.avg_duration_ms.toFixed(0)}ms).`,
        metric: {
          currAvgMs: curr.avg_duration_ms,
          baseAvgMs: base.avg_duration_ms,
          multiplier: curr.avg_duration_ms / base.avg_duration_ms,
        },
        firedAt: now,
      };
      if (trackAndCooldown(alert, cooldownMs, now)) {
        await dispatch(alert);
        result.alerts.push(alert);
        result.alertsFired += 1;
      }
    }
  }

  // ── Rule 5: External calls correlate with DB saturation ────────────
  // For each integration with calls in the last hour, count what fraction
  // of those minute-buckets coincided with a `pool_state_samples` row
  // showing `utilization_pct >= saturation_pct`.
  const correlation = await rows<{
    integration: string;
    total_minutes: number;
    saturated_minutes: number;
  }>(
    workerDb.execute(sql`
      WITH call_minutes AS (
        SELECT integration,
               (called_at - (called_at % 60000)) AS minute_bucket
        FROM external_call_audits
        WHERE called_at >= ${last1hStart}
        GROUP BY integration, minute_bucket
      ),
      saturated AS (
        SELECT DISTINCT (sampled_at - (sampled_at % 60000)) AS minute_bucket
        FROM pool_state_samples
        WHERE sampled_at >= ${last1hStart}
          AND pool_name = 'api'
          AND utilization_pct >= ${config.saturationPct}
      )
      SELECT cm.integration,
             COUNT(*)::int AS total_minutes,
             COUNT(*) FILTER (WHERE s.minute_bucket IS NOT NULL)::int AS saturated_minutes
      FROM call_minutes cm
      LEFT JOIN saturated s USING (minute_bucket)
      GROUP BY cm.integration
      HAVING COUNT(*) >= 5
    `),
  );
  for (const row of correlation) {
    const pct = (row.saturated_minutes / row.total_minutes) * 100;
    if (pct < config.saturationCorrelationPct) continue;
    const alert: ActiveAlert = {
      kind: "db_saturation_correlation",
      integration: row.integration,
      message: `:warning: *External-call ↔ DB-saturation correlation* — \`${row.integration}\` calls in the last hour overlapped with API-pool saturation (≥${config.saturationPct}%) in ${pct.toFixed(0)}% of minutes (${row.saturated_minutes}/${row.total_minutes}). External call storm is a likely contributor to pool pressure.`,
      metric: {
        totalMinutes: row.total_minutes,
        saturatedMinutes: row.saturated_minutes,
        pct,
        saturationThresholdPct: config.saturationPct,
      },
      firedAt: now,
    };
    if (trackAndCooldown(alert, cooldownMs, now)) {
      await dispatch(alert);
      result.alerts.push(alert);
      result.alertsFired += 1;
    }
  }

  return result;
}

export function getActiveExternalCallAlerts(windowMs = 60 * 60_000): ActiveAlert[] {
  const cutoff = Date.now() - windowMs;
  return activeAlerts.filter((a) => a.firedAt >= cutoff).slice().reverse();
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await withDbAttribution(
        "scheduler:external-call-audit-alerts",
        () => evaluateExternalCallAlerts(),
      );
      if (r.alertsFired > 0) {
        console.log(
          `[ExternalCallAuditAlerts] tick fired=${r.alertsFired} enabled=${r.enabled} killSwitch=${r.killSwitchEnabled}`,
        );
      }
    } catch (err: any) {
      console.warn(`[ExternalCallAuditAlerts] tick failed: ${err?.message ?? err}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startExternalCallAuditAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void runWithWorkerDb(() => tick());
  }, CHECK_INTERVAL_MS);
  if (typeof (interval as any).unref === "function") {
    (interval as any).unref();
  }
  console.log(
    `[ExternalCallAuditAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopExternalCallAuditAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  resetState(): void {
    activeAlerts.length = 0;
    lastAlertAt.clear();
    dispatcherOverride = null;
    killSwitchOverride = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setKillSwitchForTests(fn: (() => boolean) | null): void {
    killSwitchOverride = fn;
  },
  CHECK_INTERVAL_MS,
};
