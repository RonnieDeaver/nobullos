// @db-pool-intent: worker
// @cross-instance-safe: per-instance evaluation of per-instance traffic; the
//   alert fan-out rides notifyByType's health-state dedupe (one dedupeKey per
//   route: `api_route_regression:<METHOD /route>`), so overlapping instances
//   collapse into a single delivered alert, and markRecovered is idempotent.
//   A duplicate evaluation costs only a cheap in-memory window scan.
/**
 * Task #3816 — App-wide request spine, part 5: sustained per-route
 * regression alert.
 *
 * Every {@link DEFAULT_CONFIG.evalIntervalMs} the evaluator reads the rolling
 * per-route window from requestMetrics and flags any route whose p95 latency
 * or 5xx error rate sits above its band. A route must breach on
 * `consecutiveBreaches` CONSECUTIVE evaluations (with at least `minCount`
 * requests in the window each time) before an alert fires — a single slow
 * request or one bad poll can never page anyone.
 *
 * Alerting rides the unified dispatcher (`infra.api.route_regression`, one
 * dedupeKey per route: `api_route_regression:<METHOD /route>`), so the
 * existing health-state machinery provides once-per-streak dedupe + 6h
 * reminders while unhealthy. When an alerted route drops back in band (or
 * its traffic stops), we `markRecovered` so the next regression alerts
 * immediately instead of being swallowed by the reminder window.
 *
 * Config is overridable at runtime via the `request_metrics_alert_config`
 * system setting (JSON merged over {@link DEFAULT_CONFIG}), so thresholds
 * can be tuned — or the evaluator disabled — without a deploy. The global
 * `non_critical_sweeps` kill switch is honored.
 *
 * Restart note: the consecutive-breach streaks and the alerted-route set are
 * in-memory. After a restart a recovered-then-rebreaching route inside the
 * dispatcher's reminder window is deduped rather than re-alerted — accepted
 * (matches the dispatcher's semantics for every other watcher).
 */
import { isKillSwitchEnabled } from "./killSwitches";
import {
  getRequestMetricsSummary,
  ALL_ROUTES_KEY,
  type RouteWindowStats,
} from "./requestMetrics";

export const NOTIFICATION_ID = "infra.api.route_regression";
export const CONFIG_SETTING_KEY = "request_metrics_alert_config";

export interface RequestMetricsAlertConfig {
  enabled: boolean;
  /** Rolling window evaluated each tick. */
  windowMs: number;
  evalIntervalMs: number;
  /** p95 above this (ms) counts as a latency breach. */
  p95Ms: number;
  /** 5xx rate above this (percent) counts as an error-rate breach. */
  errorRatePct: number;
  /** Minimum requests in the window for a route to be judged at all. */
  minCount: number;
  /** Breaches on this many consecutive evaluations before alerting. */
  consecutiveBreaches: number;
}

export const DEFAULT_CONFIG: RequestMetricsAlertConfig = {
  enabled: true,
  windowMs: 10 * 60_000,
  evalIntervalMs: 60_000,
  p95Ms: 2_500,
  errorRatePct: 20,
  minCount: 30,
  consecutiveBreaches: 3,
};

export type BreachKind = "p95" | "error_rate";

interface RouteAlertState {
  streak: number;
  kind: BreachKind | null;
  alerted: boolean;
  lastAlertAt: number;
}

const stateByRoute = new Map<string, RouteAlertState>();
/** Bound the state map like the aggregator (stale entries pruned per tick). */
const MAX_TRACKED = 600;

/**
 * Last config the evaluator actually loaded (settings row over defaults).
 * Surfaced in the health-console snapshot so operators see the EFFECTIVE
 * bands, not the compile-time defaults, when the settings row diverges.
 */
let lastLoadedConfig: RequestMetricsAlertConfig | null = null;

// ── test seams (tableSizeWatchdog pattern) ───────────────────────────────────
type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: unknown },
  options: Record<string, unknown>,
) => Promise<{ delivered: boolean; skipped?: boolean; status?: string; skipReason?: string }>;
type MarkRecoveredFn = (notificationId: string, dedupeKey: string) => Promise<void>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let markRecoveredOverride: MarkRecoveredFn | null = null;
let configOverride: Partial<RequestMetricsAlertConfig> | null = null;

async function loadConfig(): Promise<RequestMetricsAlertConfig> {
  if (configOverride) return { ...DEFAULT_CONFIG, ...configOverride };
  try {
    const { storage } = await import("../storage");
    const row = await storage.getSystemSetting(CONFIG_SETTING_KEY);
    if (!row?.value) return DEFAULT_CONFIG;
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object") return DEFAULT_CONFIG;
    const merged: RequestMetricsAlertConfig = { ...DEFAULT_CONFIG };
    if (typeof parsed.enabled === "boolean") merged.enabled = parsed.enabled;
    for (const k of ["windowMs", "evalIntervalMs", "p95Ms", "errorRatePct", "minCount", "consecutiveBreaches"] as const) {
      const v = Number(parsed[k]);
      if (Number.isFinite(v) && v > 0) merged[k] = v;
    }
    return merged;
  } catch {
    // Settings read failed (boot race, DB blip) — evaluate with defaults
    // rather than silently skipping the safety net.
    return DEFAULT_CONFIG;
  }
}

function classifyBreach(row: RouteWindowStats, cfg: RequestMetricsAlertConfig): BreachKind | null {
  if (row.count < cfg.minCount) return null;
  // Error rate first: a route that is BOTH slow and failing is primarily
  // an error-rate incident (the 5xxs usually explain the latency).
  if (row.err5xxRatePct > cfg.errorRatePct) return "error_rate";
  if (row.p95Ms > cfg.p95Ms) return "p95";
  return null;
}

function buildAlertText(row: RouteWindowStats, kind: BreachKind, cfg: RequestMetricsAlertConfig, streak: number): string {
  const windowMin = Math.round(cfg.windowMs / 60_000);
  const headline =
    kind === "error_rate"
      ? `\`${row.route}\` 5xx rate is *${row.err5xxRatePct}%* (band ${cfg.errorRatePct}%)`
      : `\`${row.route}\` p95 is *${row.p95Ms}ms* (band ${cfg.p95Ms}ms)`;
  return [
    `:rotating_light: *API route regression* — ${headline}`,
    `• last ${windowMin} min: ${row.count} req · p50 ${row.p50Ms}ms · p95 ${row.p95Ms}ms · max ${row.maxMs}ms · 5xx ${row.err5xx} (${row.err5xxRatePct}%) · 4xx ${row.err4xx}`,
    `• sustained across ${streak} consecutive ${Math.round(cfg.evalIntervalMs / 1000)}s evaluations (each ≥${cfg.minCount} req)`,
    `• Correlate with \`rid=\` access-log lines for this route, then System Health → Health → API Route Metrics. Tune bands via system_settings \`${CONFIG_SETTING_KEY}\` (JSON).`,
  ].join("\n");
}

export interface RouteEvaluation {
  route: string;
  kind: BreachKind | null;
  streak: number;
  decision: "ok" | "building" | "alerted" | "alert_deduped_or_skipped" | "recovered";
}

export interface AlertsTickResult {
  ran: boolean;
  skippedReason?: string;
  evaluations: RouteEvaluation[];
}

/**
 * One evaluation pass. Exported for tests (seams above) and reused by the
 * interval tick. Per-instance by design: each autoscale instance judges the
 * traffic it served; the dispatcher dedupes cross-instance alerts.
 */
export async function evaluateOnce(now: number = Date.now()): Promise<AlertsTickResult> {
  const cfg = await loadConfig();
  lastLoadedConfig = cfg;
  if (!cfg.enabled) return { ran: false, skippedReason: "disabled", evaluations: [] };
  if (isKillSwitchEnabled("non_critical_sweeps")) {
    return { ran: false, skippedReason: "kill_switch", evaluations: [] };
  }

  const summary = getRequestMetricsSummary({ windowMs: cfg.windowMs, limit: 200, minCount: 1, now });
  const evaluations: RouteEvaluation[] = [];
  const seen = new Set<string>();

  for (const row of summary.routes) {
    if (row.route === ALL_ROUTES_KEY) continue;
    seen.add(row.route);
    const kind = classifyBreach(row, cfg);
    let state = stateByRoute.get(row.route);
    if (kind) {
      if (!state) {
        state = { streak: 0, kind: null, alerted: false, lastAlertAt: 0 };
        stateByRoute.set(row.route, state);
      }
      state.streak += 1;
      state.kind = kind;
      if (state.streak >= cfg.consecutiveBreaches) {
        const notify = dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
        let decision: RouteEvaluation["decision"];
        try {
          const r = await notify(
            NOTIFICATION_ID,
            {
              text: buildAlertText(row, kind, cfg, state.streak),
              preview: { route: row.route, kind, p95Ms: row.p95Ms, err5xxRatePct: row.err5xxRatePct },
            },
            {
              triggerSource: "alert_service",
              // Sustained-breach dedupe + 6h reminders live in the
              // dispatcher's health-state machinery, keyed per route.
              dedupeKey: `api_route_regression:${row.route}`,
              failureType: kind,
              metadata: {
                route: row.route,
                kind,
                count: row.count,
                p50Ms: row.p50Ms,
                p95Ms: row.p95Ms,
                maxMs: row.maxMs,
                err4xx: row.err4xx,
                err5xx: row.err5xx,
                err5xxRatePct: row.err5xxRatePct,
                bandP95Ms: cfg.p95Ms,
                bandErrorRatePct: cfg.errorRatePct,
                streak: state.streak,
              },
            },
          );
          decision = r.delivered ? "alerted" : "alert_deduped_or_skipped";
        } catch (err: any) {
          console.error(`[RequestMetricsAlerts] dispatch failed for ${row.route}: ${err?.message ?? err}`);
          decision = "alert_deduped_or_skipped";
        }
        state.alerted = true;
        state.lastAlertAt = now;
        evaluations.push({ route: row.route, kind, streak: state.streak, decision });
      } else {
        evaluations.push({ route: row.route, kind, streak: state.streak, decision: "building" });
      }
    } else if (state) {
      // In band this evaluation → streak broken.
      const wasAlerted = state.alerted;
      state.streak = 0;
      state.kind = null;
      if (wasAlerted) {
        state.alerted = false;
        const markRecovered =
          markRecoveredOverride ?? (await import("./notifications/dispatcher")).markRecovered;
        try {
          await markRecovered(NOTIFICATION_ID, `api_route_regression:${row.route}`);
        } catch {}
        evaluations.push({ route: row.route, kind: null, streak: 0, decision: "recovered" });
      } else {
        stateByRoute.delete(row.route);
      }
    }
  }

  // Routes with alert state but no traffic in this window: the regression
  // evidence is gone (traffic stopped) — recover alerted ones, drop the rest.
  for (const [route, state] of [...stateByRoute]) {
    if (seen.has(route)) continue;
    if (state.alerted) {
      state.alerted = false;
      state.streak = 0;
      state.kind = null;
      const markRecovered =
        markRecoveredOverride ?? (await import("./notifications/dispatcher")).markRecovered;
      try {
        await markRecovered(NOTIFICATION_ID, `api_route_regression:${route}`);
      } catch {}
      evaluations.push({ route, kind: null, streak: 0, decision: "recovered" });
      stateByRoute.delete(route);
    } else {
      stateByRoute.delete(route);
    }
  }

  // Safety: bound the map (cannot realistically exceed the aggregator's own
  // route cap, but a config with minCount=1 on a scan-happy client might).
  if (stateByRoute.size > MAX_TRACKED) {
    for (const [route, state] of [...stateByRoute]) {
      if (stateByRoute.size <= MAX_TRACKED) break;
      if (!state.alerted) stateByRoute.delete(route);
    }
  }

  return { ran: true, evaluations };
}

/** Snapshot for the health console panel. */
export function getAlertStateSnapshot(): {
  notificationId: string;
  defaults: RequestMetricsAlertConfig;
  /** Effective config from the most recent evaluation (defaults until the first tick). */
  config: RequestMetricsAlertConfig;
  breaching: Array<{ route: string; kind: BreachKind | null; streak: number; alerted: boolean }>;
} {
  const breaching: Array<{ route: string; kind: BreachKind | null; streak: number; alerted: boolean }> = [];
  for (const [route, state] of stateByRoute) {
    if (state.streak > 0 || state.alerted) {
      breaching.push({ route, kind: state.kind, streak: state.streak, alerted: state.alerted });
    }
  }
  breaching.sort((a, b) => b.streak - a.streak);
  return {
    notificationId: NOTIFICATION_ID,
    defaults: DEFAULT_CONFIG,
    config: lastLoadedConfig ?? DEFAULT_CONFIG,
    breaching,
  };
}

// ── scheduler ────────────────────────────────────────────────────────────────

let tickTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await evaluateOnce();
  } catch (err: any) {
    console.warn(`[RequestMetricsAlerts] tick failed: ${err?.message ?? err}`);
  } finally {
    inFlight = false;
  }
}

export function startRequestMetricsAlertsScheduler(): void {
  if (tickTimer) return;
  // First evaluation after 90s so boot traffic (warmups, first dashboard
  // load) doesn't seed misleading windows.
  setTimeout(() => {
    void tick();
  }, 90_000);
  tickTimer = setInterval(() => {
    void tick();
  }, DEFAULT_CONFIG.evalIntervalMs);
  if (typeof (tickTimer as any).unref === "function") (tickTimer as any).unref();
  console.log(
    `[RequestMetricsAlerts] started — evaluating per-route p95/error-rate bands every ${DEFAULT_CONFIG.evalIntervalMs / 1000}s (config via ${CONFIG_SETTING_KEY})`,
  );
}

export function stopRequestMetricsAlertsScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export const __testHelpers = {
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setMarkRecoveredForTests(fn: MarkRecoveredFn | null): void {
    markRecoveredOverride = fn;
  },
  setConfigForTests(cfg: Partial<RequestMetricsAlertConfig> | null): void {
    configOverride = cfg;
  },
  resetStateForTests(): void {
    stateByRoute.clear();
    lastLoadedConfig = null;
  },
};
