/**
 * Task #1643 — Front Analytics coverage-drop / below-floor alerts.
 *
 * Fires when:
 *   1. All-time applied coverage drops by more than
 *      `front_analytics_coverage_drop_delta_pct` (default 2.0) since
 *      the previous tick's snapshot, OR
 *   2. Any month's applied coverage falls below
 *      `front_analytics_month_floor_pct` (default 95.0), OR
 *   3. (Task #2090) Any finalized month is classified by the Task #2087
 *      completeness deriver as `ingest-gap` / `apply-gap` /
 *      `not-measured` — a masked gap the % thresholds above miss. Gated
 *      separately by `front_analytics_completeness_alerts_enabled`
 *      (default OFF) so the existing alert behavior is unchanged unless
 *      an operator opts in.
 *
 * Gated by `front_analytics_coverage_alerts_enabled` kill switch.
 *
 * Dedupe: in-memory `(condition, month)` keys with the previous
 * snapshot persisted in `system_settings.front_analytics_coverage_alert_state`.
 * The completeness condition dedupes per `(month, status)` so a month
 * re-alerts only when its completeness status changes.
 *
 * Task #2819 — denominator floor-raise alert. When a coverage refresh has
 * to correct a month's message denominator UPWARD (Task #2795's floor
 * invariant: local message count exceeded Front's reported total, stored
 * as `denominatorFloorExcess` + a reconciliation note), an operator alert
 * fires through its own notification id
 * (`integration.front.coverage_denominator_floor_raise`). Dedupe is
 * per-month-per-raise: a month alerts when it FIRST gains an excess (no
 * excess previously alerted) or when its excess grows materially (by
 * `front_analytics_floor_raise_regrowth_pct`, default 25%) past the
 * last-alerted value — never on every refresh tick. Gated by the same
 * master kill switch plus its own opt-out
 * (`front_analytics_floor_raise_alerts_enabled`, default ON — a NEW raise
 * is always worth a proactive nudge; recurring/growing excess usually
 * means Front's Analytics totals and NoBull's local tables are drifting).
 */
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import {
  getFrontAnalyticsCoverageSummary,
  type CoverageSummary,
  type CoverageCompletenessStatus,
} from "./frontAnalyticsCoverage";

export const NOTIFICATION_ID = "integration.front.analytics_coverage_drop";
// Task #2819 — dedicated notification id for the denominator floor-raise
// alert so operators can toggle it independently of the coverage-drop /
// below-floor alert in the notifications registry.
export const FLOOR_RAISE_NOTIFICATION_ID =
  "integration.front.coverage_denominator_floor_raise";

export const SETTING_ENABLED = "front_analytics_coverage_alerts_enabled";
export const SETTING_DROP_DELTA_PCT = "front_analytics_coverage_drop_delta_pct";
export const SETTING_MONTH_FLOOR_PCT = "front_analytics_month_floor_pct";
// Task #2090 — opt-in completeness alert switch. Default OFF so the
// existing drop / below-floor behavior is unchanged unless an operator
// turns it on.
export const SETTING_COMPLETENESS_ALERTS_ENABLED =
  "front_analytics_completeness_alerts_enabled";
// Task #2819 — floor-raise alert switch (default ON: a NEW upward
// denominator correction is always worth a proactive nudge) and the
// material-regrowth threshold: a month that already alerted re-alerts
// only when its excess grows by at least this percentage past the
// last-alerted value.
export const SETTING_FLOOR_RAISE_ALERTS_ENABLED =
  "front_analytics_floor_raise_alerts_enabled";
export const SETTING_FLOOR_RAISE_REGROWTH_PCT =
  "front_analytics_floor_raise_regrowth_pct";
export const SETTING_PREVIOUS_SNAPSHOT =
  "front_analytics_coverage_alert_state";

export const DEFAULTS = {
  enabled: true,
  dropDeltaPct: 2.0,
  monthFloorPct: 95.0,
  completenessAlertsEnabled: false,
  floorRaiseAlertsEnabled: true,
  floorRaiseRegrowthPct: 25.0,
} as const;

/**
 * Task #2090 — the finalized-month completeness statuses that warrant an
 * operator alert. `covered` and `in-progress` are intentionally excluded
 * (nothing actionable / still settling).
 */
export const ALERTABLE_COMPLETENESS_STATUSES: ReadonlySet<CoverageCompletenessStatus> =
  new Set<CoverageCompletenessStatus>(["ingest-gap", "apply-gap", "not-measured"]);

export const MIN_DROP_DELTA_PCT = 0.1;
export const MAX_DROP_DELTA_PCT = 100;
export const MIN_MONTH_FLOOR_PCT = 0;
export const MAX_MONTH_FLOOR_PCT = 100;
// Task #2834 — bounds for the floor-raise material-regrowth threshold.
// 0 means "re-alert on any excess growth"; regrowth is relative to the
// last-alerted excess so values above 100% are meaningful (excess must
// more than double), capped at 1000% to keep the knob sane.
export const MIN_FLOOR_RAISE_REGROWTH_PCT = 0;
export const MAX_FLOOR_RAISE_REGROWTH_PCT = 1000;

export interface FrontAnalyticsCoverageAlertConfig {
  enabled: boolean;
  dropDeltaPct: number;
  monthFloorPct: number;
  completenessAlertsEnabled: boolean;
  floorRaiseAlertsEnabled: boolean;
  floorRaiseRegrowthPct: number;
}

export async function getFrontAnalyticsCoverageAlertConfig(): Promise<FrontAnalyticsCoverageAlertConfig> {
  const [enabledRow, dropRow, floorRow, completenessRow, floorRaiseRow, regrowthRow] =
    await Promise.all([
      getSystemSetting(SETTING_ENABLED).catch(() => null),
      getSystemSetting(SETTING_DROP_DELTA_PCT).catch(() => null),
      getSystemSetting(SETTING_MONTH_FLOOR_PCT).catch(() => null),
      getSystemSetting(SETTING_COMPLETENESS_ALERTS_ENABLED).catch(() => null),
      getSystemSetting(SETTING_FLOOR_RAISE_ALERTS_ENABLED).catch(() => null),
      getSystemSetting(SETTING_FLOOR_RAISE_REGROWTH_PCT).catch(() => null),
    ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    dropDeltaPct: parseFloatSetting(dropRow?.value, DEFAULTS.dropDeltaPct),
    monthFloorPct: parseFloatSetting(floorRow?.value, DEFAULTS.monthFloorPct),
    completenessAlertsEnabled: parseBool(
      completenessRow?.value,
      DEFAULTS.completenessAlertsEnabled,
    ),
    floorRaiseAlertsEnabled: parseBool(
      floorRaiseRow?.value,
      DEFAULTS.floorRaiseAlertsEnabled,
    ),
    floorRaiseRegrowthPct: parseFloatSetting(
      regrowthRow?.value,
      DEFAULTS.floorRaiseRegrowthPct,
    ),
  };
}

export async function setFrontAnalyticsCoverageAlertEnabled(
  enabled: boolean,
  updatedBy: string,
): Promise<boolean> {
  await setSystemSetting(SETTING_ENABLED, enabled ? "true" : "false", updatedBy);
  return enabled;
}

export async function setFrontAnalyticsCoverageDropDeltaPct(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isFinite(value) ||
    value < MIN_DROP_DELTA_PCT ||
    value > MAX_DROP_DELTA_PCT
  ) {
    throw new Error(
      `drop delta must be a number between ${MIN_DROP_DELTA_PCT} and ${MAX_DROP_DELTA_PCT}`,
    );
  }
  const rounded = Math.round(value * 100) / 100;
  await setSystemSetting(SETTING_DROP_DELTA_PCT, String(rounded), updatedBy);
  return rounded;
}

export async function setFrontAnalyticsCoverageMonthFloorPct(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isFinite(value) ||
    value < MIN_MONTH_FLOOR_PCT ||
    value > MAX_MONTH_FLOOR_PCT
  ) {
    throw new Error(
      `month floor must be a number between ${MIN_MONTH_FLOOR_PCT} and ${MAX_MONTH_FLOOR_PCT}`,
    );
  }
  const rounded = Math.round(value * 100) / 100;
  await setSystemSetting(SETTING_MONTH_FLOOR_PCT, String(rounded), updatedBy);
  return rounded;
}

export async function setFrontAnalyticsCompletenessAlertsEnabled(
  enabled: boolean,
  updatedBy: string,
): Promise<boolean> {
  await setSystemSetting(
    SETTING_COMPLETENESS_ALERTS_ENABLED,
    enabled ? "true" : "false",
    updatedBy,
  );
  return enabled;
}

// Task #2834 — admin-editable setters for the Task #2819 floor-raise
// alert switch and its material-regrowth threshold, matching the
// validate → round → persist pattern of the other threshold setters.
export async function setFrontAnalyticsFloorRaiseAlertsEnabled(
  enabled: boolean,
  updatedBy: string,
): Promise<boolean> {
  await setSystemSetting(
    SETTING_FLOOR_RAISE_ALERTS_ENABLED,
    enabled ? "true" : "false",
    updatedBy,
  );
  return enabled;
}

export async function setFrontAnalyticsFloorRaiseRegrowthPct(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isFinite(value) ||
    value < MIN_FLOOR_RAISE_REGROWTH_PCT ||
    value > MAX_FLOOR_RAISE_REGROWTH_PCT
  ) {
    throw new Error(
      `floor-raise regrowth must be a number between ${MIN_FLOOR_RAISE_REGROWTH_PCT} and ${MAX_FLOOR_RAISE_REGROWTH_PCT}`,
    );
  }
  const rounded = Math.round(value * 100) / 100;
  await setSystemSetting(
    SETTING_FLOOR_RAISE_REGROWTH_PCT,
    String(rounded),
    updatedBy,
  );
  return rounded;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function parseFloatSetting(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

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
let summaryOverride: (() => Promise<CoverageSummary>) | null = null;

// Task #2819 — the alerted variants are combinatorial across four
// conditions (drop / floor / completeness / floor_raise), so the alerted
// arm is a template literal: `alerted_` + fired types joined by `_and_`
// in that fixed order (e.g. "alerted_floor_raise",
// "alerted_drop_and_floor_raise").
export type CoverageAlertDecision =
  | `alerted_${string}`
  | "skipped_disabled"
  | "skipped_no_change"
  | "skipped_no_data"
  | "skipped_baseline_seeded"
  | "skipped_send_failed"
  | "skipped_cooldown";

export interface CoverageAlertCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  appliedCoveragePct: number;
  previousAppliedCoveragePct: number | null;
  deltaPct: number | null;
  belowFloorMonths: Array<{ month: string; pct: number }>;
  /**
   * Task #2090 — finalized months whose completeness status warranted an
   * alert this tick (post-dedupe). Empty when the completeness path is
   * disabled or nothing newly regressed.
   */
  completenessAlertMonths: Array<{
    month: string;
    status: CoverageCompletenessStatus;
  }>;
  /**
   * Task #2819 — months whose denominator floor raise warranted an alert
   * this tick (post-dedupe): first-ever excess or material regrowth past
   * the last-alerted value. Empty when the path is disabled or nothing
   * newly raised.
   */
  floorRaiseAlertMonths: Array<{
    month: string;
    excess: number;
    previousAlertedExcess: number | null;
    note: string | null;
  }>;
  decision: CoverageAlertDecision;
  skipReason?: string;
}

interface SnapshotState {
  appliedCoveragePct: number;
  takenAt: string;
  alertedBelowFloorMonths: string[];
  /**
   * Task #2090 — per-month completeness status already alerted on, keyed
   * by month. A month re-alerts only when its status differs from the
   * stored value (dedupe consistent with the per-month floor dedupe).
   */
  alertedCompletenessMonths: Record<string, CoverageCompletenessStatus>;
  /**
   * Task #2819 — last-alerted denominator floor excess per month. A month
   * re-alerts only when its current excess grows materially past this
   * value (or when the entry is absent — a NEW raise). Entries are
   * cleared when a month's excess returns to 0/null so a future fresh
   * raise alerts again.
   */
  alertedFloorRaiseMonths: Record<string, number>;
  /**
   * Task #2819 — transient (never persisted) marker set when the loaded
   * snapshot PREDATES the floor-raise feature (field absent, as opposed
   * to intentionally empty). The first tick after deploy must SEED the
   * map from current raises rather than treating every pre-existing
   * excess as a "new" raise — otherwise upgrading fires one-time
   * catch-up alerts.
   */
  floorRaiseMapMissing?: boolean;
}

async function loadPreviousSnapshot(): Promise<SnapshotState | null> {
  const row = await getSystemSetting(SETTING_PREVIOUS_SNAPSHOT).catch(
    () => null,
  );
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as SnapshotState;
    if (typeof parsed.appliedCoveragePct !== "number") return null;
    return {
      appliedCoveragePct: parsed.appliedCoveragePct,
      takenAt: parsed.takenAt ?? new Date(0).toISOString(),
      alertedBelowFloorMonths: Array.isArray(parsed.alertedBelowFloorMonths)
        ? parsed.alertedBelowFloorMonths
        : [],
      alertedCompletenessMonths:
        parsed.alertedCompletenessMonths &&
        typeof parsed.alertedCompletenessMonths === "object"
          ? parsed.alertedCompletenessMonths
          : {},
      alertedFloorRaiseMonths:
        parsed.alertedFloorRaiseMonths &&
        typeof parsed.alertedFloorRaiseMonths === "object"
          ? parsed.alertedFloorRaiseMonths
          : {},
      // Distinguish "legacy snapshot without the field" from an
      // intentionally empty map — the former must seed, not alert.
      floorRaiseMapMissing:
        !parsed.alertedFloorRaiseMonths ||
        typeof parsed.alertedFloorRaiseMonths !== "object",
    };
  } catch {
    return null;
  }
}

async function persistSnapshot(state: SnapshotState): Promise<void> {
  await setSystemSetting(
    SETTING_PREVIOUS_SNAPSHOT,
    JSON.stringify(state),
    "system",
  );
}

function buildDropText(opts: {
  previous: number;
  current: number;
  delta: number;
  belowFloor: Array<{ month: string; pct: number }>;
  ingestGap: number;
  applyGap: number;
}): string {
  const worst =
    opts.belowFloor.length > 0
      ? `\n• Worst month: ${opts.belowFloor[0].month} @ ${opts.belowFloor[0].pct.toFixed(1)}%`
      : "";
  const advice =
    opts.ingestGap >= opts.applyGap
      ? "Ingest gap dominates → investigate Front Historical Recovery (Front has emails we never fetched)."
      : "Apply gap dominates → investigate apply backlog (Task #1641).";
  return [
    `:warning: *Front Analytics coverage dropped*`,
    `• All-time applied coverage: ${opts.previous.toFixed(2)}% → ${opts.current.toFixed(2)}% (Δ ${(-opts.delta).toFixed(2)}pp)`,
    `• Ingest gap (Front has, we never fetched): ${opts.ingestGap.toLocaleString()}`,
    `• Apply gap (we fetched, never applied): ${opts.applyGap.toLocaleString()}`,
    `• Action: ${advice}${worst}`,
  ].join("\n");
}

function buildFloorText(opts: {
  belowFloor: Array<{ month: string; pct: number }>;
  floorPct: number;
}): string {
  const lines = opts.belowFloor
    .slice(0, 5)
    .map((m) => `• ${m.month}: ${m.pct.toFixed(1)}%`);
  return [
    `:warning: *Front Analytics month coverage below floor (${opts.floorPct.toFixed(1)}%)*`,
    ...lines,
  ].join("\n");
}

const COMPLETENESS_STATUS_LABEL: Record<CoverageCompletenessStatus, string> = {
  "ingest-gap": "ingest gap (Front has messages we never fetched)",
  "apply-gap": "apply gap (fetched messages never applied)",
  "not-measured": "not measured (denominator missing / failed)",
  "in-progress": "in progress",
  covered: "covered",
};

/**
 * Task #2819 — operator-facing text for a denominator floor raise. Names
 * each month, the excess (how many messages the denominator was raised
 * by), and the row's reconciliation note explaining which source
 * reported the lower total.
 */
function buildFloorRaiseText(opts: {
  months: Array<{
    month: string;
    excess: number;
    previousAlertedExcess: number | null;
    note: string | null;
  }>;
}): string {
  const lines = opts.months.slice(0, 5).flatMap((m) => {
    const kind =
      m.previousAlertedExcess != null
        ? `grew from ${m.previousAlertedExcess.toLocaleString()} to ${m.excess.toLocaleString()}`
        : `raised by ${m.excess.toLocaleString()} messages`;
    const head = `• ${m.month}: denominator ${kind} (local message count exceeded Front's reported total)`;
    return m.note ? [head, `    ↳ ${m.note}`] : [head];
  });
  return [
    `:warning: *Front coverage denominator corrected upward*`,
    ...lines,
    `• Action: recurring or growing excess usually means Front's Analytics totals and NoBull's local tables are drifting — review the month(s) in the Front coverage console.`,
  ].join("\n");
}

function buildCompletenessText(opts: {
  months: Array<{
    month: string;
    status: CoverageCompletenessStatus;
    reason: string | null;
  }>;
}): string {
  const lines = opts.months.slice(0, 5).map((m) => {
    const label = COMPLETENESS_STATUS_LABEL[m.status] ?? m.status;
    const reason = m.reason ? ` — ${m.reason}` : "";
    return `• ${m.month}: *${label}*${reason}`;
  });
  return [
    `:warning: *Front Analytics finalized month(s) incomplete*`,
    ...lines,
    `• Action: investigate Front Historical Recovery / apply backlog for the months above.`,
  ].join("\n");
}

async function dispatch(
  text: string,
  metadata: Record<string, unknown>,
  notificationId: string = NOTIFICATION_ID,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      notificationId,
      { text, preview: text.slice(0, 300) },
      { triggerSource: "alert_service", metadata },
    );
    return {
      delivered: r.delivered,
      skipReason: r.delivered ? undefined : (r.skipReason ?? r.status),
    };
  } catch (err: any) {
    return {
      delivered: false,
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
    };
  }
}

export async function runFrontAnalyticsCoverageAlertCheck(
  now: number = Date.now(),
): Promise<CoverageAlertCheckResult> {
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    DEFAULTS.enabled,
  );
  const dropDeltaPct = parseFloatSetting(
    (await getSystemSetting(SETTING_DROP_DELTA_PCT).catch(() => null))?.value,
    DEFAULTS.dropDeltaPct,
  );
  const floorPct = parseFloatSetting(
    (await getSystemSetting(SETTING_MONTH_FLOOR_PCT).catch(() => null))?.value,
    DEFAULTS.monthFloorPct,
  );
  // Task #2090 — separate opt-in switch (default OFF) so existing
  // drop / below-floor behavior is unchanged unless an operator opts in.
  const completenessEnabled = parseBool(
    (
      await getSystemSetting(SETTING_COMPLETENESS_ALERTS_ENABLED).catch(
        () => null,
      )
    )?.value,
    DEFAULTS.completenessAlertsEnabled,
  );
  // Task #2819 — floor-raise alert switch (default ON) + material
  // regrowth threshold for the per-month-per-raise dedupe.
  const floorRaiseEnabled = parseBool(
    (
      await getSystemSetting(SETTING_FLOOR_RAISE_ALERTS_ENABLED).catch(
        () => null,
      )
    )?.value,
    DEFAULTS.floorRaiseAlertsEnabled,
  );
  const floorRaiseRegrowthPct = parseFloatSetting(
    (
      await getSystemSetting(SETTING_FLOOR_RAISE_REGROWTH_PCT).catch(
        () => null,
      )
    )?.value,
    DEFAULTS.floorRaiseRegrowthPct,
  );

  const summary = await (summaryOverride ?? getFrontAnalyticsCoverageSummary)();
  const result: CoverageAlertCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled,
    appliedCoveragePct: summary.allTime.appliedCoveragePct,
    previousAppliedCoveragePct: null,
    deltaPct: null,
    belowFloorMonths: [],
    completenessAlertMonths: [],
    floorRaiseAlertMonths: [],
    decision: "skipped_no_data",
  };

  if (summary.byMonth.length === 0) {
    result.skipReason = "no cached months";
    return result;
  }

  const belowFloor = summary.byMonth
    .filter((m) => m.frontTotalMessages > 0 && m.appliedCoveragePct < floorPct)
    .map((m) => ({ month: m.month, pct: m.appliedCoveragePct }))
    .sort((a, b) => a.pct - b.pct);
  result.belowFloorMonths = belowFloor;

  // Task #2090 — finalized months the completeness deriver flagged as a
  // masked gap. Only finalized months are considered (in-progress /
  // current months are still settling). Empty when the path is disabled.
  const completenessGapMonths = completenessEnabled
    ? summary.byMonth
        .filter(
          (m) =>
            m.isFinalizedMonth &&
            ALERTABLE_COMPLETENESS_STATUSES.has(m.completenessStatus),
        )
        .map((m) => ({
          month: m.month,
          status: m.completenessStatus,
          reason: m.completenessReason ?? null,
        }))
    : [];

  // Task #2819 — every month currently carrying a denominator floor
  // excess (computed regardless of the sub-switch: the dedupe map must
  // stay pruned/accurate even while the alert itself is off).
  const currentFloorRaises = summary.byMonth
    .filter((m) => (m.denominatorFloorExcess ?? 0) > 0)
    .map((m) => ({
      month: m.month,
      excess: m.denominatorFloorExcess as number,
      note: m.denominatorFloorReconciliationNote ?? null,
    }));

  const previous = await loadPreviousSnapshot();
  result.previousAppliedCoveragePct = previous?.appliedCoveragePct ?? null;
  if (previous) {
    result.deltaPct = summary.allTime.appliedCoveragePct - previous.appliedCoveragePct;
  }

  // Helper to build the completeness dedupe map for the next snapshot.
  const completenessMapFrom = (
    base: Record<string, CoverageCompletenessStatus>,
    fired: Array<{ month: string; status: CoverageCompletenessStatus }>,
  ): Record<string, CoverageCompletenessStatus> => {
    const next = { ...base };
    for (const m of fired) next[m.month] = m.status;
    return next;
  };
  // On seed paths we record the CURRENT gap set so enabling/first-run
  // never alerts on a pre-existing gap — symmetric with the floor seed.
  const seedCompletenessMap = (): Record<string, CoverageCompletenessStatus> => {
    const m: Record<string, CoverageCompletenessStatus> = {};
    for (const g of completenessGapMonths) m[g.month] = g.status;
    return m;
  };
  // Task #2819 — floor-raise dedupe map helpers. `floorRaiseMapFrom`
  // carries forward the last-ALERTED excess for months that still carry
  // one (so sub-threshold growth accumulates toward the regrowth
  // trigger), drops months whose excess cleared (a future fresh raise
  // re-alerts), and stamps newly-fired months at their alerted excess.
  const floorRaiseMapFrom = (
    base: Record<string, number>,
    fired: Array<{ month: string; excess: number }>,
  ): Record<string, number> => {
    const stillRaised = new Set(currentFloorRaises.map((m) => m.month));
    const next: Record<string, number> = {};
    for (const [month, excess] of Object.entries(base)) {
      if (stillRaised.has(month)) next[month] = excess;
    }
    for (const m of fired) next[m.month] = m.excess;
    return next;
  };
  // Seed: record every current raise so first-run/enabling never alerts
  // on a pre-existing excess — symmetric with the other seeds.
  const seedFloorRaiseMap = (): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const r of currentFloorRaises) m[r.month] = r.excess;
    return m;
  };
  // While the sub-switch is OFF, every tick SEEDS (records the current
  // raises) instead of carrying the alerted-map forward, so flipping the
  // switch back on never fires catch-up alerts for raises that happened
  // during the disabled window — same semantics as the master-switch and
  // baseline seeds above.
  const nextFloorRaiseMap = (
    fired: Array<{ month: string; excess: number }>,
  ): Record<string, number> =>
    floorRaiseEnabled
      ? floorRaiseMapFrom(previous?.alertedFloorRaiseMonths ?? {}, fired)
      : seedFloorRaiseMap();
  // Migration safety: a legacy snapshot that predates the floor-raise
  // feature has no alertedFloorRaiseMonths field at all. Seed it from
  // the current raises so the first post-deploy tick never fires
  // catch-up alerts for pre-existing excesses — same semantics as the
  // first-run baseline seed.
  if (previous?.floorRaiseMapMissing) {
    previous.alertedFloorRaiseMonths = seedFloorRaiseMap();
  }

  if (!enabled) {
    // Move the baseline forward even when disabled so we don't fire
    // a stale alert the moment the kill switch is flipped back on.
    await persistSnapshot({
      appliedCoveragePct: summary.allTime.appliedCoveragePct,
      takenAt: new Date(now).toISOString(),
      alertedBelowFloorMonths: previous?.alertedBelowFloorMonths ?? [],
      alertedCompletenessMonths: previous?.alertedCompletenessMonths ?? {},
      // Task #2819 — seed the floor-raise map while the master switch is
      // off so flipping it back on never fires for raises that happened
      // during the disabled window (symmetric with the baseline seed).
      alertedFloorRaiseMonths: seedFloorRaiseMap(),
    });
    result.decision = "skipped_disabled";
    result.skipReason = "alert disabled in system_settings";
    return result;
  }

  if (!previous) {
    await persistSnapshot({
      appliedCoveragePct: summary.allTime.appliedCoveragePct,
      takenAt: new Date(now).toISOString(),
      alertedBelowFloorMonths: belowFloor.map((m) => m.month),
      alertedCompletenessMonths: seedCompletenessMap(),
      alertedFloorRaiseMonths: seedFloorRaiseMap(),
    });
    result.decision = "skipped_baseline_seeded";
    result.skipReason = "first run — baseline established";
    return result;
  }

  const drop =
    summary.allTime.appliedCoveragePct - previous.appliedCoveragePct;
  const droppedTooMuch = drop < 0 && Math.abs(drop) > dropDeltaPct;
  const newBelowFloor = belowFloor.filter(
    (m) => !previous.alertedBelowFloorMonths.includes(m.month),
  );
  // Dedupe per (month, status): re-alert only when a month is newly
  // gappy OR its completeness status changed since the last alert.
  const newCompleteness = completenessGapMonths.filter(
    (m) => previous.alertedCompletenessMonths[m.month] !== m.status,
  );
  result.completenessAlertMonths = newCompleteness.map((m) => ({
    month: m.month,
    status: m.status,
  }));

  // Task #2819 — per-month-per-raise dedupe: fire when the month has no
  // last-alerted excess (a NEW raise), or its excess grew materially past
  // the last-alerted value (≥ regrowth % over it). A refresh tick that
  // rewrites the same (or slightly larger) excess stays silent.
  const newFloorRaises = floorRaiseEnabled
    ? currentFloorRaises
        .map((m) => {
          const prior = previous.alertedFloorRaiseMonths[m.month];
          return {
            ...m,
            previousAlertedExcess: prior != null ? prior : null,
          };
        })
        .filter(
          (m) =>
            m.previousAlertedExcess == null ||
            m.excess >=
              m.previousAlertedExcess * (1 + floorRaiseRegrowthPct / 100),
        )
    : [];
  result.floorRaiseAlertMonths = newFloorRaises.map((m) => ({
    month: m.month,
    excess: m.excess,
    previousAlertedExcess: m.previousAlertedExcess,
    note: m.note,
  }));

  if (
    !droppedTooMuch &&
    newBelowFloor.length === 0 &&
    newCompleteness.length === 0 &&
    newFloorRaises.length === 0
  ) {
    // Persist current snapshot so deltas stay meaningful across ticks.
    await persistSnapshot({
      appliedCoveragePct: summary.allTime.appliedCoveragePct,
      takenAt: new Date(now).toISOString(),
      // Don't forget months already alerted on so we don't re-alert them.
      alertedBelowFloorMonths: previous.alertedBelowFloorMonths,
      // Track the latest status of every currently-gappy month so a
      // status change (e.g. ingest-gap → apply-gap) re-fires next tick,
      // while an unchanged status stays deduped.
      alertedCompletenessMonths: completenessMapFrom(
        previous.alertedCompletenessMonths,
        completenessGapMonths,
      ),
      // Task #2819 — keep last-alerted excesses (so sub-threshold growth
      // accumulates) and prune months whose excess cleared; while the
      // sub-switch is OFF this seeds instead so re-enabling never fires
      // for raises during the disabled window.
      alertedFloorRaiseMonths: nextFloorRaiseMap([]),
    });
    result.decision = "skipped_no_change";
    return result;
  }

  const messages: string[] = [];
  if (droppedTooMuch) {
    messages.push(
      buildDropText({
        previous: previous.appliedCoveragePct,
        current: summary.allTime.appliedCoveragePct,
        delta: drop,
        belowFloor,
        ingestGap: summary.allTime.ingestGap,
        applyGap: summary.allTime.applyGap,
      }),
    );
  }
  if (newBelowFloor.length > 0) {
    messages.push(buildFloorText({ belowFloor: newBelowFloor, floorPct }));
  }
  if (newCompleteness.length > 0) {
    messages.push(buildCompletenessText({ months: newCompleteness }));
  }

  // Classic conditions (drop / floor / completeness) share the original
  // notification id; the floor raise (Task #2819) dispatches separately
  // to its own id so operators can route/toggle it independently.
  let classicDelivered = messages.length > 0 ? false : null;
  let classicSkipReason: string | undefined;
  if (messages.length > 0) {
    const r = await dispatch(messages.join("\n\n"), {
      event: "coverage_alert",
      droppedTooMuch,
      appliedCoveragePct: summary.allTime.appliedCoveragePct,
      previousAppliedCoveragePct: previous.appliedCoveragePct,
      dropDeltaPct,
      monthFloorPct: floorPct,
      ingestGap: summary.allTime.ingestGap,
      applyGap: summary.allTime.applyGap,
      newBelowFloorMonths: newBelowFloor.map((m) => m.month),
      newCompletenessMonths: newCompleteness.map((m) => ({
        month: m.month,
        status: m.status,
      })),
    });
    classicDelivered = r.delivered;
    classicSkipReason = r.skipReason;
  }

  let floorRaiseDelivered: boolean | null = null;
  let floorRaiseSkipReason: string | undefined;
  if (newFloorRaises.length > 0) {
    const r = await dispatch(
      buildFloorRaiseText({ months: newFloorRaises }),
      {
        event: "coverage_denominator_floor_raise",
        floorRaiseRegrowthPct,
        months: newFloorRaises.map((m) => ({
          month: m.month,
          excess: m.excess,
          previousAlertedExcess: m.previousAlertedExcess,
        })),
      },
      FLOOR_RAISE_NOTIFICATION_ID,
    );
    floorRaiseDelivered = r.delivered;
    floorRaiseSkipReason = r.skipReason;
  }

  if (classicDelivered !== true && floorRaiseDelivered !== true) {
    // Nothing got out — don't advance any dedupe state so the next tick
    // retries everything (original send-failed semantics).
    result.decision = "skipped_send_failed";
    result.skipReason = classicSkipReason ?? floorRaiseSkipReason;
    return result;
  }

  // Persist only the delivered side's dedupe so a failed side retries
  // next tick. If the classic dispatch failed, keep the previous baseline
  // pct (so the drop re-fires) and the previous floor/completeness maps.
  await persistSnapshot({
    appliedCoveragePct:
      classicDelivered === false
        ? previous.appliedCoveragePct
        : summary.allTime.appliedCoveragePct,
    takenAt: new Date(now).toISOString(),
    alertedBelowFloorMonths:
      classicDelivered === false
        ? previous.alertedBelowFloorMonths
        : Array.from(
            new Set([
              ...previous.alertedBelowFloorMonths,
              ...newBelowFloor.map((m) => m.month),
            ]),
          ),
    // Record the current status of every gappy month so re-alerts only
    // fire on a status change, mirroring the floor dedupe.
    alertedCompletenessMonths:
      classicDelivered === false
        ? previous.alertedCompletenessMonths
        : completenessMapFrom(
            previous.alertedCompletenessMonths,
            completenessGapMonths,
          ),
    // Task #2819 — stamp fired months at their alerted excess only when
    // that dispatch actually delivered; otherwise carry the prior map so
    // the raise re-fires next tick.
    alertedFloorRaiseMonths:
      floorRaiseDelivered === false
        ? previous.alertedFloorRaiseMonths
        : nextFloorRaiseMap(newFloorRaises),
  });
  const firedTypes = [
    droppedTooMuch && classicDelivered === true ? "drop" : null,
    newBelowFloor.length > 0 && classicDelivered === true ? "floor" : null,
    newCompleteness.length > 0 && classicDelivered === true
      ? "completeness"
      : null,
    floorRaiseDelivered === true ? "floor_raise" : null,
  ].filter(Boolean);
  result.decision = `alerted_${firedTypes.join("_and_")}` as CoverageAlertDecision;
  if (classicDelivered === false) result.skipReason = classicSkipReason;
  else if (floorRaiseDelivered === false)
    result.skipReason = floorRaiseSkipReason;
  return result;
}

export const __frontAnalyticsCoverageAlertsTestHelpers = {
  NOTIFICATION_ID,
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setSummaryForTests(fn: (() => Promise<CoverageSummary>) | null): void {
    summaryOverride = fn;
  },
};
