/**
 * Task #774 — alert when an audit prune deletes an unusually large number of rows.
 *
 * Now that operators can tune retention without redeploying (via
 * `admin_audit_retention_days` and the per-IP / blocked_ip caps), a
 * misconfiguration could quietly delete a large amount of audit history.
 * `runPruneOnce` already records per-table delete counts as `PruneEvent`s in
 * `system_settings.<table>_prune_events`; this module compares the most recent
 * event for each table against a baseline drawn from the prior events and
 * fires a Slack/email alert (via `notifyByType`) when the new delete count is
 * an outlier.
 *
 * A delete is anomalous when BOTH:
 *   - `removed >= min_rows_floor` (absolute floor — default 1,000), AND
 *   - `removed >= ratio_multiplier * baseline_avg` where the baseline is the
 *     mean of the prior `baseline_window` events (default 10) for the same
 *     table, ignoring zero-delete runs (most scheduled prunes remove 0 rows).
 *
 * If there are no prior non-zero events the ratio check is skipped — the
 * absolute floor alone gates the alert. Per-table cooldown
 * (`cooldown_minutes`, default 60) prevents spam when several manual prunes
 * happen back-to-back during an incident.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `infra.audit_prune.unusually_large_delete`; threshold knobs live in
 * `system_settings` so an admin can tune them without a deploy.
 */
import { getSystemSetting } from "../storage/settingsStorage";
import {
  listPruneEvents,
  type PruneEvent,
  type PruneTable,
  type PruneTrigger,
} from "./auditPruneEvents";

const NOTIFICATION_ID = "infra.audit_prune.unusually_large_delete";

export const SETTING_ENABLED = "audit_prune_anomaly_alert_enabled";
export const SETTING_MIN_ROWS = "audit_prune_anomaly_min_rows";
export const SETTING_RATIO = "audit_prune_anomaly_ratio_multiplier";
export const SETTING_BASELINE_WINDOW = "audit_prune_anomaly_baseline_window";
export const SETTING_COOLDOWN = "audit_prune_anomaly_cooldown_minutes";

export const AUDIT_PRUNE_ANOMALY_DEFAULTS = {
  enabled: true,
  minRows: 1_000,
  ratioMultiplier: 5,
  baselineWindow: 10,
  cooldownMinutes: 60,
};

export const AUDIT_PRUNE_ANOMALY_CONFIG_AUDIT_KEY =
  "audit_prune_anomaly_config";

const DEFAULTS = AUDIT_PRUNE_ANOMALY_DEFAULTS;

export interface AuditPruneAnomalyConfig {
  enabled: boolean;
  minRows: number;
  ratioMultiplier: number;
  baselineWindow: number;
  cooldownMinutes: number;
}

interface LastAlertRecord {
  at: number;
  removed: number;
  eventAt: string;
}

const lastAlertByTable = new Map<PruneTable, LastAlertRecord>();

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

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

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

export async function getAuditPruneAnomalyConfig(): Promise<AuditPruneAnomalyConfig> {
  const [enabledRow, minRowsRow, ratioRow, windowRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_MIN_ROWS).catch(() => null),
    getSystemSetting(SETTING_RATIO).catch(() => null),
    getSystemSetting(SETTING_BASELINE_WINDOW).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    minRows: parsePositiveInt(minRowsRow?.value, DEFAULTS.minRows),
    ratioMultiplier: parsePositiveNumber(ratioRow?.value, DEFAULTS.ratioMultiplier),
    baselineWindow: parsePositiveInt(windowRow?.value, DEFAULTS.baselineWindow),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
  };
}

export interface BaselineSummary {
  /** Number of prior non-zero events used in the average. */
  sampleSize: number;
  /** Mean of the non-zero `removed` values from prior events. */
  averageRemoved: number;
  /** Largest prior `removed` value across the window (0 if none). */
  maxRemoved: number;
}

export function computeBaseline(
  priorEvents: PruneEvent[],
  windowSize: number,
): BaselineSummary {
  const window = priorEvents.slice(0, Math.max(1, windowSize));
  const nonZero = window.filter((e) => e.removed > 0);
  if (nonZero.length === 0) {
    return { sampleSize: 0, averageRemoved: 0, maxRemoved: 0 };
  }
  const total = nonZero.reduce((sum, e) => sum + e.removed, 0);
  const max = nonZero.reduce((m, e) => (e.removed > m ? e.removed : m), 0);
  return {
    sampleSize: nonZero.length,
    averageRemoved: total / nonZero.length,
    maxRemoved: max,
  };
}

export type AnomalyDecision =
  | "alerted"
  | "skipped_disabled"
  | "skipped_zero_removed"
  | "skipped_below_floor"
  | "skipped_below_ratio"
  | "skipped_cooldown"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped";

export interface PerTableAnomalyResult {
  table: PruneTable;
  removed: number;
  baseline: BaselineSummary;
  decision: AnomalyDecision;
  skipReason?: string;
}

function buildAlertText(args: {
  table: PruneTable;
  event: PruneEvent;
  baseline: BaselineSummary;
  config: AuditPruneAnomalyConfig;
  ratioObserved: number | null;
}): string {
  const trigger = args.event.trigger ?? "scheduled";
  const triggeredBy = args.event.triggeredBy
    ? ` by \`${args.event.triggeredBy}\``
    : "";
  const ratioLine =
    args.baseline.sampleSize > 0 && args.ratioObserved !== null
      ? `• Baseline: avg *${args.baseline.averageRemoved.toFixed(0)}* / max *${args.baseline.maxRemoved}* over last *${args.baseline.sampleSize}* non-zero run(s) — this run is *${args.ratioObserved.toFixed(1)}x* baseline avg`
      : `• Baseline: no prior non-zero runs in the last ${args.config.baselineWindow} events — only the absolute floor (≥${args.config.minRows} rows) was checked`;
  const lines = [
    `:warning: *Audit prune deleted an unusually large number of rows* — \`${args.table}\``,
    `• Removed *${args.event.removed}* row(s) at ${args.event.at} (trigger: \`${trigger}\`${triggeredBy})`,
    ratioLine,
    `• Thresholds: removed ≥ *${args.config.minRows}* rows AND ≥ *${args.config.ratioMultiplier}x* baseline avg (when baseline exists)`,
    args.event.maxAgeDays > 0
      ? `• Retention window at run time: *${args.event.maxAgeDays}* day(s)`
      : `• Per-scope cap at run time: *${args.event.maxEntries}* entries`,
    `If this prune was unintended, check the retention/cap settings and consider a database point-in-time recovery.`,
  ];
  return lines.join("\n");
}

/**
 * Evaluate the most recent prune event for a single table and dispatch a
 * notification if it crosses the anomaly threshold. Safe to call from inside
 * `runPruneOnce` — never throws; logs and records the outcome.
 *
 * Tests can supply `loadEvents` / `dispatcher` overrides; production paths
 * leave them undefined to use the real `listPruneEvents` and
 * `notifyByType`.
 */
export async function evaluateAndAlertForTable(
  table: PruneTable,
  currentEvent: PruneEvent,
  options: {
    config?: AuditPruneAnomalyConfig;
    now?: number;
    loadEvents?: (table: PruneTable) => Promise<PruneEvent[]>;
    dispatcher?: NotifyByTypeFn;
  } = {},
): Promise<PerTableAnomalyResult> {
  const now = options.now ?? Date.now();
  const config = options.config ?? (await getAuditPruneAnomalyConfig());

  if (!config.enabled) {
    return {
      table,
      removed: currentEvent.removed,
      baseline: { sampleSize: 0, averageRemoved: 0, maxRemoved: 0 },
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    };
  }
  if (currentEvent.removed <= 0) {
    return {
      table,
      removed: currentEvent.removed,
      baseline: { sampleSize: 0, averageRemoved: 0, maxRemoved: 0 },
      decision: "skipped_zero_removed",
      skipReason: "no rows deleted",
    };
  }

  // `listPruneEvents` returns newest-first; the current event is index 0
  // because `recordPruneEvent` ran before us. Drop it so the baseline only
  // reflects PRIOR runs.
  const loader = options.loadEvents ?? listPruneEvents;
  const allEvents = await loader(table).catch(() => [] as PruneEvent[]);
  const priorEvents = allEvents.filter(
    (e) => !(e.at === currentEvent.at && e.removed === currentEvent.removed),
  );
  const baseline = computeBaseline(priorEvents, config.baselineWindow);

  if (currentEvent.removed < config.minRows) {
    return {
      table,
      removed: currentEvent.removed,
      baseline,
      decision: "skipped_below_floor",
      skipReason: `removed ${currentEvent.removed} < min_rows ${config.minRows}`,
    };
  }

  const ratioObserved =
    baseline.sampleSize > 0 && baseline.averageRemoved > 0
      ? currentEvent.removed / baseline.averageRemoved
      : null;
  if (ratioObserved !== null && ratioObserved < config.ratioMultiplier) {
    return {
      table,
      removed: currentEvent.removed,
      baseline,
      decision: "skipped_below_ratio",
      skipReason: `ratio ${ratioObserved.toFixed(2)} < ${config.ratioMultiplier} (baseline avg ${baseline.averageRemoved.toFixed(0)})`,
    };
  }

  const last = lastAlertByTable.get(table);
  if (last) {
    const elapsedMs = now - last.at;
    const cooldownMs = config.cooldownMinutes * 60_000;
    if (elapsedMs < cooldownMs) {
      return {
        table,
        removed: currentEvent.removed,
        baseline,
        decision: "skipped_cooldown",
        skipReason: `cooldown ${Math.round(elapsedMs / 60_000)}m < ${config.cooldownMinutes}m (last alerted at ${new Date(last.at).toISOString()})`,
      };
    }
  }

  const text = buildAlertText({
    table,
    event: currentEvent,
    baseline,
    config,
    ratioObserved,
  });

  let delivered = false;
  let skipReason: string | undefined;
  try {
    const notifyByType =
      options.dispatcher ??
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        // Per-table cooldown above already prevents spam.
        bypassDedupe: true,
        metadata: {
          table,
          removed: currentEvent.removed,
          baselineAverage: Number(baseline.averageRemoved.toFixed(2)),
          baselineSampleSize: baseline.sampleSize,
          baselineMax: baseline.maxRemoved,
          ratioObserved:
            ratioObserved !== null ? Number(ratioObserved.toFixed(2)) : null,
          minRows: config.minRows,
          ratioMultiplier: config.ratioMultiplier,
          trigger: currentEvent.trigger ?? "scheduled",
          triggeredBy: currentEvent.triggeredBy ?? null,
          eventAt: currentEvent.at,
          maxEntries: currentEvent.maxEntries,
          maxAgeDays: currentEvent.maxAgeDays,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      `[AuditPruneAnomalyAlerts] dispatch failed for ${table}: ${err?.message}`,
    );
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    lastAlertByTable.set(table, {
      at: now,
      removed: currentEvent.removed,
      eventAt: currentEvent.at,
    });
    return {
      table,
      removed: currentEvent.removed,
      baseline,
      decision: "alerted",
    };
  }
  return {
    table,
    removed: currentEvent.removed,
    baseline,
    decision: skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped",
    skipReason,
  };
}

/**
 * Convenience wrapper that evaluates a batch of (table, removed) pairs from a
 * single `runPruneOnce` invocation. Reads the live config once and reuses it
 * for every per-table evaluation.
 */
export async function evaluatePruneRun(
  events: Array<{
    table: PruneTable;
    event: PruneEvent;
  }>,
  options: { now?: number } = {},
): Promise<PerTableAnomalyResult[]> {
  const config = await getAuditPruneAnomalyConfig();
  const results: PerTableAnomalyResult[] = [];
  for (const { table, event } of events) {
    try {
      const r = await evaluateAndAlertForTable(table, event, {
        config,
        now: options.now,
      });
      results.push(r);
    } catch (err: any) {
      console.error(
        `[AuditPruneAnomalyAlerts] evaluation failed for ${table}: ${err?.message}`,
      );
    }
  }
  if (results.some((r) => r.decision === "alerted")) {
    const alerted = results.filter((r) => r.decision === "alerted");
    console.log(
      `[AuditPruneAnomalyAlerts] sent ${alerted.length} anomaly alert(s): ` +
        alerted.map((r) => `${r.table}=${r.removed}`).join(", "),
    );
  }
  return results;
}

/**
 * Pure (no-side-effect) variant of {@link evaluateAndAlertForTable} used by
 * the Audit Retention admin screen to surface "what would have happened if
 * we evaluated this event right now" — same decision tree, no notification
 * dispatched, no cooldown cache touched.
 *
 * Caller supplies the FULL event list (newest-first). This helper picks the
 * most recent event as the "current" one and uses the rest as the baseline,
 * matching `evaluateAndAlertForTable`'s split semantics.
 */
export interface PruneEventAnomalySummary {
  /** The event that was evaluated (most recent). */
  event: PruneEvent | null;
  /** Decision the alert evaluator would have reached. */
  decision: AnomalyDecision | "skipped_no_event";
  /** Baseline summary computed from the prior events. */
  baseline: BaselineSummary;
  /** Observed `removed / baseline.averageRemoved`, or null when baseline empty. */
  ratioObserved: number | null;
  /** Thresholds in effect at evaluation time. */
  config: AuditPruneAnomalyConfig;
  /**
   * ISO timestamp of the most recent *successful* alert dispatch for this
   * table, sourced by the caller from `notification_deliveries`. Optional —
   * the helper itself cannot read DB.
   */
  lastAlertedAt?: string | null;
  /** Human-friendly reason text for skipped_* decisions. */
  skipReason?: string;
}

export function summarizePruneEventDecision(
  events: PruneEvent[],
  config: AuditPruneAnomalyConfig,
  options: {
    /**
     * Successful alert dispatch timestamps for this table, in any order.
     * Used to decide event-time cooldown vs alerted purely from the event's
     * own timestamp (NEVER from `Date.now()`), so historical decisions stay
     * stable as wall-clock time advances.
     */
    deliveryTimestamps?: ReadonlyArray<string>;
  } = {},
): PruneEventAnomalySummary {
  const deliveryMs = (options.deliveryTimestamps ?? [])
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  const newestDeliveryMs = deliveryMs[0];
  const lastAlertedAt = Number.isFinite(newestDeliveryMs)
    ? new Date(newestDeliveryMs).toISOString()
    : null;
  const current = events[0] ?? null;
  if (!current) {
    return {
      event: null,
      decision: "skipped_no_event",
      baseline: { sampleSize: 0, averageRemoved: 0, maxRemoved: 0 },
      ratioObserved: null,
      config,
      lastAlertedAt,
      skipReason: "no prune events recorded yet",
    };
  }
  const baseline = computeBaseline(events.slice(1), config.baselineWindow);
  const ratioObserved =
    baseline.sampleSize > 0 && baseline.averageRemoved > 0
      ? current.removed / baseline.averageRemoved
      : null;

  if (!config.enabled) {
    return {
      event: current,
      decision: "skipped_disabled",
      baseline,
      ratioObserved,
      config,
      lastAlertedAt,
      skipReason: "alert disabled in system_settings",
    };
  }
  if (current.removed <= 0) {
    return {
      event: current,
      decision: "skipped_zero_removed",
      baseline,
      ratioObserved,
      config,
      lastAlertedAt,
      skipReason: "no rows deleted",
    };
  }
  if (current.removed < config.minRows) {
    return {
      event: current,
      decision: "skipped_below_floor",
      baseline,
      ratioObserved,
      config,
      lastAlertedAt,
      skipReason: `removed ${current.removed} < min_rows ${config.minRows}`,
    };
  }
  if (ratioObserved !== null && ratioObserved < config.ratioMultiplier) {
    return {
      event: current,
      decision: "skipped_below_ratio",
      baseline,
      ratioObserved,
      config,
      lastAlertedAt,
      skipReason: `ratio ${ratioObserved.toFixed(2)} < ${config.ratioMultiplier} (baseline avg ${baseline.averageRemoved.toFixed(0)})`,
    };
  }
  // Threshold crossed. Decide *event-time* whether an alert fired or was
  // suppressed by cooldown. Using `current.at` (and not `Date.now()`) keeps
  // historical decisions stable: a cooldown-suppressed prune from yesterday
  // never silently flips to `alerted` once the cooldown window elapses in
  // wall-clock time.
  const cooldownMs = config.cooldownMinutes * 60_000;
  const matchWindowMs = 5 * 60_000; // delivery row written within ~5m of the event
  const eventTs = Date.parse(current.at);
  // 1) Did a successful delivery for this exact event get persisted?
  //    `evaluateAndAlertForTable` writes the delivery row synchronously
  //    after `runPruneOnce` records the event, so we expect a match within
  //    a few minutes of `event.at`.
  const matchedDeliveryMs = Number.isFinite(eventTs)
    ? deliveryMs.find(
        (ms) => ms >= eventTs - 60_000 && ms <= eventTs + matchWindowMs,
      )
    : undefined;
  if (matchedDeliveryMs !== undefined) {
    return {
      event: current,
      decision: "alerted",
      baseline,
      ratioObserved,
      config,
      lastAlertedAt: new Date(matchedDeliveryMs).toISOString(),
    };
  }
  // 2) No delivery for this event — check whether a *prior* successful
  //    alert (strictly before `event.at`) falls inside the cooldown window.
  const priorDeliveryMs = Number.isFinite(eventTs)
    ? deliveryMs.find((ms) => ms < eventTs)
    : undefined;
  if (priorDeliveryMs !== undefined && eventTs - priorDeliveryMs < cooldownMs) {
    return {
      event: current,
      decision: "skipped_cooldown",
      baseline,
      ratioObserved,
      config,
      lastAlertedAt,
      skipReason: `cooldown ${Math.round((eventTs - priorDeliveryMs) / 60_000)}m < ${config.cooldownMinutes}m (prior alert ${new Date(priorDeliveryMs).toISOString()})`,
    };
  }
  // 3) Threshold crossed, no cooldown, but no delivery row recorded.
  //    Most common cause is a dispatcher-level skip (notifications disabled
  //    or all channels failed). Surface it as such instead of falsely
  //    claiming an alert went out.
  return {
    event: current,
    decision: "skipped_dispatcher_skipped",
    baseline,
    ratioObserved,
    config,
    lastAlertedAt,
    skipReason: "threshold crossed but no successful delivery row found",
  };
}

export type { PruneEvent, PruneTable, PruneTrigger };

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastAlertByTable.clear();
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
