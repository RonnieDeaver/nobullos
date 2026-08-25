/**
 * Task #928 — Post-deploy verification service.
 *
 * Surfaces the §8 checklist from `docs/db-health-runbook.md` as a single
 * machine-runnable report so an operator can confirm — in one click after
 * each rollout — that:
 *
 *   913F.1  Sampler verification
 *   913F.2  Incident verification
 *   913F.3  Attribution verification
 *   913F.4  Health-metric correctness
 *
 * Also provides:
 *   - `snapshotBaseline()` — persist the current numeric metrics in
 *     `system_settings` so the next run can render a "compare to last
 *     deploy" view.
 *   - `forceResolveLegacyStuckIncidents()` — close the documented legacy
 *     `db_latency:warning:probe` row plus any leftover `snoozed` rows
 *     whose freshness window has elapsed.
 */

import { sql } from "drizzle-orm";
// @periodic-request-pool-exception: boot-seeded ONE-SHOT verification checklist (staggered startup task, not a recurring loop) plus admin request-path routes; reads are small and interactive by design.
import { db } from "../db";
import { getSupervisedSamplerStates } from "./supervisedSampler";
import {
  listIncidents,
  getMaxTimestamp,
} from "../storage/healthMetricsStorage";
import { getFreshness } from "./healthRollups";
import { computeOverview } from "./healthOverview";
import {
  getSystemSetting,
  setSystemSetting,
  deleteSystemSetting,
} from "../storage/settingsStorage";
import { resolveIncident } from "./healthIncidents";

const BASELINE_KEY = "post_deploy_verification:last_baseline";
const BASELINE_HISTORY_KEY = "post_deploy_verification:baseline_history";
const BASELINE_HISTORY_LIMIT = 10;
// Task #1007 — short-lived "trash" so a mistakenly deleted baseline can be
// restored. Capped at the most recent 5 deletions, entries older than 24h
// are pruned on every read.
const BASELINE_TRASH_KEY = "post_deploy_verification:baseline_trash";
const BASELINE_TRASH_LIMIT = 5;
const BASELINE_TRASH_TTL_MS = 24 * 60 * 60_000;
const AUTO_BASELINE_DISABLED_KEY =
  "post_deploy_verification:auto_baseline_disabled";
// Task #1018 — per-(baseline,metric) acknowledgements. When a row in the
// "Compare to last deploy" table is already-triaged the operator can ack it
// to silence the red tint / worst-drift sort. Saving a new baseline clears
// every acknowledgement (since the comparison surface is now different).
const ACKNOWLEDGEMENTS_KEY = "post_deploy_verification:acknowledgements";
const LEGACY_PROBE_FINGERPRINT = "db_latency:warning:probe";
const LEGACY_PROBE_GRACE_MS = 15 * 60_000; // 15 min per runbook §8

/** Task #974 — wait this long after boot before snapshotting the baseline,
 *  giving samplers/rollups time to warm up. */
export const AUTO_BASELINE_BOOT_DELAY_MS = 5 * 60_000;
/** Marker stored in `BaselineSnapshot.savedBy` so the panel can render
 *  "auto-saved at <time>" instead of treating it like an operator click. */
export const AUTO_BASELINE_SAVED_BY = "auto:boot";

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckRow {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Optional numeric value, surfaced for the compare-to-last-deploy view. */
  numeric?: number | null;
}

export interface CheckGroup {
  id: string;
  title: string;
  status: CheckStatus;
  checks: CheckRow[];
}

export interface BaselineSnapshot {
  /** Stable identifier for selecting this entry from history. Equals `savedAt`. */
  id: number;
  savedAt: number;
  savedBy: string | null;
  metrics: Record<string, number | null>;
  /** Overall checklist status at the time the baseline was saved. */
  overallStatus: CheckStatus | null;
}

export interface MetricAcknowledgement {
  by: string | null;
  at: number;
}

export interface ComparisonRow {
  key: string;
  label: string;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  /** Non-fatal hint about whether the drift is in the bad direction. */
  drift: "better" | "worse" | "same" | "unknown";
  /** Task #1018 — set when an operator has dismissed this row for the active baseline. */
  acknowledgement: MetricAcknowledgement | null;
}

export interface VerificationReport {
  generatedAt: number;
  overall: CheckStatus;
  groups: CheckGroup[];
  /** The baseline being compared against (selected from `baselines`). */
  baseline: BaselineSnapshot | null;
  /** Task #983 — recent baselines, newest first (capped at ~10). */
  baselines: BaselineSnapshot[];
  comparison: ComparisonRow[];
  /** Pre-computed metric snapshot — same shape as `baseline.metrics`. */
  metrics: Record<string, number | null>;
  /** Task #974 — auto-snapshot toggle state for the panel. */
  autoBaseline: { enabled: boolean };
  /** Task #1007 — recently deleted baselines available for restore. */
  baselineTrash: BaselineTrashEntry[];
}

/** Task #1007 — a soft-deleted baseline kept for one-click restore. */
export interface BaselineTrashEntry {
  snapshot: BaselineSnapshot;
  deletedAt: number;
  deletedBy: string | null;
}

function aggregate(statuses: CheckStatus[]): CheckStatus {
  if (statuses.some((s) => s === "fail")) return "fail";
  if (statuses.some((s) => s === "warn")) return "warn";
  return "pass";
}

function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

// ─── Group 913F.1 — Sampler verification ────────────────────────────────
async function checkSamplers(now: number, postDeployWindowStart: number): Promise<CheckGroup> {
  const checks: CheckRow[] = [];

  // (a) health_samples freshness
  try {
    const last = await getMaxTimestamp("health_samples", "timestamp");
    const ageMs = last == null ? null : now - last;
    const limitMs = 60_000; // 30s cadence × 2
    checks.push({
      id: "health_samples_fresh",
      label: "health_samples MAX(timestamp) < 2× cadence",
      status: ageMs == null ? "fail" : ageMs <= limitMs ? "pass" : "fail",
      detail:
        ageMs == null
          ? "no rows ever recorded"
          : `last row ${fmtAge(ageMs)} ago (limit ${fmtAge(limitMs)})`,
      numeric: ageMs,
    });
  } catch (err: any) {
    checks.push({
      id: "health_samples_fresh",
      label: "health_samples MAX(timestamp) < 2× cadence",
      status: "fail",
      detail: `query error: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  // (b) pool_state_samples freshness
  try {
    const last = await getMaxTimestamp("pool_state_samples", "sampled_at");
    const ageMs = last == null ? null : now - last;
    const limitMs = 120_000; // 60s cadence × 2
    checks.push({
      id: "pool_state_samples_fresh",
      label: "pool_state_samples MAX(sampled_at) < 2× cadence",
      status: ageMs == null ? "fail" : ageMs <= limitMs ? "pass" : "fail",
      detail:
        ageMs == null
          ? "no rows ever recorded"
          : `last row ${fmtAge(ageMs)} ago (limit ${fmtAge(limitMs)})`,
      numeric: ageMs,
    });
  } catch (err: any) {
    checks.push({
      id: "pool_state_samples_fresh",
      label: "pool_state_samples MAX(sampled_at) < 2× cadence",
      status: "fail",
      detail: `query error: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  // (c) every supervised sampler running, healthy, no consecutive failures
  try {
    const samplers = getSupervisedSamplerStates();
    if (samplers.length === 0) {
      checks.push({
        id: "samplers_runtime",
        label: "all supervised samplers running & healthy",
        status: "warn",
        detail: "no supervised samplers registered yet (boot in progress?)",
      });
    } else {
      const unhealthy = samplers.filter(
        (s) => !s.running || !s.healthy || (s.consecutiveFailures ?? 0) > 0,
      );
      checks.push({
        id: "samplers_runtime",
        label: "all supervised samplers running & healthy",
        status: unhealthy.length === 0 ? "pass" : "fail",
        detail:
          unhealthy.length === 0
            ? `${samplers.length} sampler(s) green`
            : `unhealthy: ${unhealthy
                .map(
                  (s) =>
                    `${(s as any).name ?? "?"}(running=${s.running},healthy=${s.healthy},failures=${s.consecutiveFailures})`,
                )
                .join(", ")}`,
        numeric: unhealthy.length,
      });
    }
  } catch (err: any) {
    checks.push({
      id: "samplers_runtime",
      label: "all supervised samplers running & healthy",
      status: "fail",
      detail: `runtime state unavailable: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  // (d) no new health_sampler_stalled incidents in the post-deploy window
  try {
    const recent = await listIncidents({
      sinceTimestamp: postDeployWindowStart,
      limit: 200,
    });
    const stalled = recent.filter((i) => i.metric === "health_sampler_stalled");
    checks.push({
      id: "no_new_stalled_incidents",
      label: "no new health_sampler_stalled incidents in post-deploy window",
      status: stalled.length === 0 ? "pass" : "fail",
      detail:
        stalled.length === 0
          ? `0 in last ${fmtAge(now - postDeployWindowStart)}`
          : `${stalled.length} new since ${new Date(postDeployWindowStart).toISOString()}`,
      numeric: stalled.length,
    });
  } catch (err: any) {
    checks.push({
      id: "no_new_stalled_incidents",
      label: "no new health_sampler_stalled incidents in post-deploy window",
      status: "warn",
      detail: `query error: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  return {
    id: "913F.1",
    title: "Sampler verification (913F.1)",
    status: aggregate(checks.map((c) => c.status)),
    checks,
  };
}

// ─── Group 913F.2 — Incident verification ───────────────────────────────
async function checkIncidents(now: number): Promise<CheckGroup> {
  const checks: CheckRow[] = [];

  // (a) legacy db_latency:warning:probe — pass if resolved OR (firing AND age<15min)
  try {
    const r = await db.execute<any>(sql`
      SELECT id, status,
             EXTRACT(EPOCH FROM NOW())*1000 - last_seen_at AS age_ms,
             resolved_at
        FROM health_incidents
       WHERE fingerprint = ${LEGACY_PROBE_FINGERPRINT}
       ORDER BY id DESC
       LIMIT 1
    `);
    const list = Array.isArray(r) ? r : (r as any).rows ?? [];
    const row = list[0];
    if (!row) {
      checks.push({
        id: "legacy_probe_incident",
        label: `legacy ${LEGACY_PROBE_FINGERPRINT} resolved or within 15-min grace`,
        status: "pass",
        detail: "no row with that fingerprint exists (clean)",
      });
    } else if (row.status === "resolved") {
      checks.push({
        id: "legacy_probe_incident",
        label: `legacy ${LEGACY_PROBE_FINGERPRINT} resolved or within 15-min grace`,
        status: "pass",
        detail: `incident #${row.id} resolved`,
      });
    } else {
      const ageMs = Number(row.age_ms ?? 0);
      const inGrace = ageMs < LEGACY_PROBE_GRACE_MS;
      checks.push({
        id: "legacy_probe_incident",
        label: `legacy ${LEGACY_PROBE_FINGERPRINT} resolved or within 15-min grace`,
        status: inGrace ? "warn" : "fail",
        detail: `incident #${row.id} status=${row.status}, last_seen ${fmtAge(ageMs)} ago${
          inGrace
            ? " (resolver is correctly holding it open while metric still fires)"
            : " (auto-resolver did not close — investigate)"
        }`,
        numeric: ageMs,
      });
    }
  } catch (err: any) {
    checks.push({
      id: "legacy_probe_incident",
      label: `legacy ${LEGACY_PROBE_FINGERPRINT} resolved or within 15-min grace`,
      status: "warn",
      detail: `query error: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  // (b) no legacy `status='snoozed'` rows remain
  try {
    const r = await db.execute<any>(sql`
      SELECT COUNT(*)::int AS c FROM health_incidents WHERE status = 'snoozed'
    `);
    const list = Array.isArray(r) ? r : (r as any).rows ?? [];
    const count = Number(list[0]?.c ?? 0);
    checks.push({
      id: "no_legacy_snoozed",
      label: "no legacy status='snoozed' rows remain",
      status: count === 0 ? "pass" : "fail",
      detail:
        count === 0
          ? "boot normalizer cleared all legacy snoozed rows"
          : `${count} legacy snoozed row(s) — run startup normalizer or use force-resolve`,
      numeric: count,
    });
  } catch (err: any) {
    checks.push({
      id: "no_legacy_snoozed",
      label: "no legacy status='snoozed' rows remain",
      status: "warn",
      detail: `query error: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  return {
    id: "913F.2",
    title: "Incident verification (913F.2)",
    status: aggregate(checks.map((c) => c.status)),
    checks,
  };
}

// ─── Group 913F.3 — Attribution verification ────────────────────────────
async function checkAttribution(): Promise<{
  group: CheckGroup;
  apiUnknownPct: number | null;
  workerUnknownPct: number | null;
}> {
  const checks: CheckRow[] = [];
  let apiUnknownPct: number | null = null;
  let workerUnknownPct: number | null = null;

  try {
    const dbModule = await import("../db");
    const apiTop = dbModule.getTopDbHoldLabels("api", 15);
    const workerTop = dbModule.getTopDbHoldLabels("worker", 15);
    apiUnknownPct = Number(apiTop.unknownPct ?? 0);
    workerUnknownPct = Number(workerTop.unknownPct ?? 0);

    for (const [pool, pct] of [
      ["api", apiUnknownPct],
      ["worker", workerUnknownPct],
    ] as Array<[string, number]>) {
      const status: CheckStatus =
        pct < 5 ? "pass" : pct < 20 ? "warn" : "fail";
      checks.push({
        id: `unknown_pct_${pool}`,
        label: `${pool} pool unknownPct < 5% (913A baseline ~99.99%)`,
        status,
        detail: `${pct.toFixed(2)}% (target <5%, regression at ≥20%)`,
        numeric: pct,
      });
    }

    // Top hold labels: per runbook §3, "unknown" should not show up in the
    // top labels at all. Tighten beyond the previous "dominant unknown"
    // heuristic — fail if either pool has `unknown` anywhere in its top 3
    // labels (means a meaningful share of holds are unattributed).
    const topApi = (apiTop.byCount ?? [])
      .slice(0, 3)
      .map((r: any) => String(r.label ?? ""))
      .filter(Boolean);
    const topWorker = (workerTop.byCount ?? [])
      .slice(0, 3)
      .map((r: any) => String(r.label ?? ""))
      .filter(Boolean);
    const apiHasUnknown = topApi.includes("unknown");
    const workerHasUnknown = topWorker.includes("unknown");
    const noTopLabels = topApi.length === 0 && topWorker.length === 0;
    let topStatus: CheckStatus;
    if (noTopLabels) topStatus = "warn";
    else if (apiHasUnknown || workerHasUnknown) topStatus = "fail";
    else topStatus = "pass";
    checks.push({
      id: "top_labels_real",
      label: "no `unknown` in either pool's top 3 hold labels",
      status: topStatus,
      detail: noTopLabels
        ? "no top-label samples yet (warming up)"
        : `api=[${topApi.join(", ")}] worker=[${topWorker.join(", ")}]`,
    });
  } catch (err: any) {
    checks.push({
      id: "attribution_unavailable",
      label: "attribution snapshot",
      status: "fail",
      detail: `attribution snapshot unavailable: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  return {
    group: {
      id: "913F.3",
      title: "Attribution verification (913F.3)",
      status: aggregate(checks.map((c) => c.status)),
      checks,
    },
    apiUnknownPct,
    workerUnknownPct,
  };
}

// ─── Group 913F.4 — Health-metric correctness ───────────────────────────
/**
 * Real gap analysis over a timestamp column: returns the maximum
 * gap (ms) between consecutive rows in the given window, plus the
 * count of gaps over `maxAcceptableGapMs`.
 */
async function analyzeContinuity(
  table: string,
  tsColumn: string,
  sinceMs: number,
  maxAcceptableGapMs: number,
): Promise<{ maxGapMs: number | null; gapCount: number; rowCount: number }> {
  // sql.raw is required because table/column names are not bind-parametrizable.
  // Both inputs come from a hard-coded allow-list in the caller, never user input.
  const r = await db.execute<any>(
    sql.raw(`
      WITH rows AS (
        SELECT ${tsColumn} AS ts FROM ${table}
         WHERE ${tsColumn} >= ${sinceMs}
         ORDER BY ${tsColumn} ASC
      ), gaps AS (
        SELECT ts - LAG(ts) OVER (ORDER BY ts) AS gap_ms FROM rows
      )
      SELECT
        (SELECT COUNT(*)::int FROM rows) AS row_count,
        COALESCE(MAX(gap_ms), 0)::bigint AS max_gap,
        COUNT(*) FILTER (WHERE gap_ms > ${maxAcceptableGapMs})::int AS over_count
      FROM gaps
    `),
  );
  const list = Array.isArray(r) ? r : (r as any).rows ?? [];
  const row = list[0];
  return {
    maxGapMs: row?.max_gap == null ? null : Number(row.max_gap),
    gapCount: Number(row?.over_count ?? 0),
    rowCount: Number(row?.row_count ?? 0),
  };
}

async function checkHealthMetrics(postDeployWindowStart: number): Promise<{
  group: CheckGroup;
  rtP95Ms: number | null;
}> {
  const checks: CheckRow[] = [];
  let rtP95Ms: number | null = null;

  try {
    const overview = await computeOverview();
    const lat = overview.latency;
    rtP95Ms = lat.roundTripP95Ms;
    const sane =
      lat.roundTripP95Ms == null
        ? false
        : Number.isFinite(lat.roundTripP95Ms) && lat.roundTripP95Ms >= 0;
    checks.push({
      id: "overview_sane",
      label: "overview returns sane numbers (no NaN, no missing fields)",
      status: sane ? "pass" : "warn",
      detail: sane
        ? `currentStatus=${overview.currentStatus}, p95=${lat.roundTripP95Ms}ms, p99=${lat.roundTripP99Ms}ms`
        : "p95 missing or non-finite — check sample writer",
      numeric: lat.roundTripP95Ms,
    });
  } catch (err: any) {
    checks.push({
      id: "overview_sane",
      label: "overview returns sane numbers (no NaN, no missing fields)",
      status: "fail",
      detail: `computeOverview failed: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  // Real continuity scan over health_samples + pool_state_samples since the
  // post-deploy window started. Per runbook §8 the bar is "no gaps > 2×
  // interval", so we use 2× the documented cadence as the acceptable gap.
  // (Tables and columns are hard-coded — no user input flows into sql.raw.)
  const continuityTargets: Array<{
    table: string;
    tsColumn: string;
    cadenceMs: number;
  }> = [
    { table: "health_samples", tsColumn: "timestamp", cadenceMs: 30_000 },
    { table: "pool_state_samples", tsColumn: "sampled_at", cadenceMs: 60_000 },
  ];
  for (const t of continuityTargets) {
    try {
      const limitMs = t.cadenceMs * 2;
      const result = await analyzeContinuity(
        t.table,
        t.tsColumn,
        postDeployWindowStart,
        limitMs,
      );
      let status: CheckStatus;
      let detail: string;
      if (result.rowCount === 0) {
        status = "warn";
        detail = `no rows since ${new Date(postDeployWindowStart).toISOString()} (window may be too short)`;
      } else if (result.gapCount > 0) {
        status = "fail";
        detail = `${result.gapCount} gap(s) > ${fmtAge(limitMs)} (max ${fmtAge(result.maxGapMs)}) over ${result.rowCount} rows`;
      } else {
        status = "pass";
        detail = `${result.rowCount} rows, max gap ${fmtAge(result.maxGapMs)} (limit ${fmtAge(limitMs)})`;
      }
      checks.push({
        id: `continuity_${t.table}`,
        label: `${t.table} series continuous (no gaps > 2× cadence)`,
        status,
        detail,
        numeric: result.gapCount,
      });
    } catch (err: any) {
      checks.push({
        id: `continuity_${t.table}`,
        label: `${t.table} series continuous (no gaps > 2× cadence)`,
        status: "warn",
        detail: `gap-scan error: ${String(err?.message ?? err).slice(0, 160)}`,
      });
    }
  }

  // Surface freshness anomalies as a separate check (kept for parity with
  // the dashboard's freshness badges — it's a snapshot, not a continuity test).
  try {
    const rows = await getFreshness();
    const broken = rows.filter((r) => r.status === "missing");
    const delayed = rows.filter((r) => r.status === "delayed");
    const status: CheckStatus =
      broken.length > 0 ? "fail" : delayed.length > 0 ? "warn" : "pass";
    checks.push({
      id: "freshness_snapshot",
      label: "all freshness targets healthy (current snapshot)",
      status,
      detail:
        status === "pass"
          ? `${rows.length} table(s) healthy`
          : [
              broken.length > 0
                ? `missing: ${broken.map((r) => r.table).join(", ")}`
                : null,
              delayed.length > 0
                ? `delayed: ${delayed.map((r) => r.table).join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join(" / "),
      numeric: broken.length,
    });
  } catch (err: any) {
    checks.push({
      id: "freshness_snapshot",
      label: "all freshness targets healthy (current snapshot)",
      status: "warn",
      detail: `freshness query error: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  // Rollups — yesterday should have a row with non-zero sample_count. Use
  // the actual stored sampleCount rather than ok%+error% (a fully-degraded
  // day still has degraded% > 0 and would be misclassified by a percent-based
  // proxy; what we really care about is whether rows landed at all).
  try {
    const yesterday = (() => {
      const d = new Date(Date.now() - 24 * 60 * 60_000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    })();
    const r = await db.execute<any>(sql`
      SELECT sample_count, ok_count, error_count, degraded_count, p95
        FROM health_daily_rollups
       WHERE date = ${yesterday}
         AND metric = 'db_round_trip_ms'
       LIMIT 1
    `);
    const list = Array.isArray(r) ? r : (r as any).rows ?? [];
    const row = list[0];
    const sampleCount = Number(row?.sample_count ?? 0);
    const ok = !!row && sampleCount > 0;
    checks.push({
      id: "rollups_landed",
      label: "yesterday's rollup landed with non-zero sample_count",
      status: ok ? "pass" : "warn",
      detail: row
        ? `${yesterday}: sample_count=${sampleCount}, ok=${row.ok_count}, degraded=${row.degraded_count}, error=${row.error_count}, p95=${row.p95 ?? "—"}ms`
        : `no rollup row for ${yesterday} yet — hourly rollup tick may still be pending`,
      numeric: sampleCount,
    });
  } catch (err: any) {
    checks.push({
      id: "rollups_landed",
      label: "yesterday's rollup landed with non-zero sample_count",
      status: "warn",
      detail: `rollup query error: ${String(err?.message ?? err).slice(0, 160)}`,
    });
  }

  return {
    group: {
      id: "913F.4",
      title: "Health-metric correctness (913F.4)",
      status: aggregate(checks.map((c) => c.status)),
      checks,
    },
    rtP95Ms,
  };
}

// ─── Baseline persistence ───────────────────────────────────────────────
function normalizeSnapshot(raw: any): BaselineSnapshot | null {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.savedAt !== "number" ||
    !raw.metrics ||
    typeof raw.metrics !== "object"
  ) {
    return null;
  }
  const id = typeof raw.id === "number" ? raw.id : raw.savedAt;
  const overallStatus =
    raw.overallStatus === "pass" ||
    raw.overallStatus === "warn" ||
    raw.overallStatus === "fail"
      ? raw.overallStatus
      : null;
  return {
    id,
    savedAt: raw.savedAt,
    savedBy: typeof raw.savedBy === "string" ? raw.savedBy : null,
    metrics: raw.metrics,
    overallStatus,
  };
}

async function loadLegacyBaseline(): Promise<BaselineSnapshot | null> {
  const setting = await getSystemSetting(BASELINE_KEY);
  if (!setting?.value) return null;
  try {
    return normalizeSnapshot(JSON.parse(setting.value));
  } catch {
    return null;
  }
}

/**
 * Task #983 — load the rolling list of recent baselines (newest first).
 * Falls back to the legacy single-row `BASELINE_KEY` setting when no history
 * has been written yet (so existing installs keep their last baseline).
 */
async function loadBaselineHistory(): Promise<BaselineSnapshot[]> {
  const setting = await getSystemSetting(BASELINE_HISTORY_KEY);
  if (setting?.value) {
    try {
      const parsed = JSON.parse(setting.value);
      if (Array.isArray(parsed)) {
        const list = parsed
          .map(normalizeSnapshot)
          .filter((s): s is BaselineSnapshot => s !== null);
        list.sort((a, b) => b.savedAt - a.savedAt);
        return list.slice(0, BASELINE_HISTORY_LIMIT);
      }
    } catch {
      /* corrupt — fall through to legacy */
    }
  }
  const legacy = await loadLegacyBaseline();
  return legacy ? [legacy] : [];
}

async function saveBaselineHistory(
  list: BaselineSnapshot[],
  by: string | null,
): Promise<void> {
  await setSystemSetting(
    BASELINE_HISTORY_KEY,
    JSON.stringify(list.slice(0, BASELINE_HISTORY_LIMIT)),
    by ?? undefined,
  );
}

/**
 * Task #1007 — load the recently-deleted baseline trash. Entries older than
 * `BASELINE_TRASH_TTL_MS` are filtered out, and the list is capped at
 * `BASELINE_TRASH_LIMIT` entries (newest first). The on-disk value is not
 * rewritten here — pruning happens lazily via `saveBaselineTrash` whenever
 * the trash is mutated, which keeps reads cheap.
 */
function normalizeTrashEntry(raw: unknown): BaselineTrashEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const snapshot = normalizeSnapshot(r.snapshot);
  const deletedAt = Number(r.deletedAt);
  if (!snapshot || !Number.isFinite(deletedAt)) return null;
  const deletedBy = typeof r.deletedBy === "string" ? r.deletedBy : null;
  return { snapshot, deletedAt, deletedBy };
}

async function loadBaselineTrash(now: number = Date.now()): Promise<
  BaselineTrashEntry[]
> {
  const setting = await getSystemSetting(BASELINE_TRASH_KEY);
  if (!setting?.value) return [];
  try {
    const parsed = JSON.parse(setting.value);
    if (!Array.isArray(parsed)) return [];
    const list = parsed
      .map(normalizeTrashEntry)
      .filter((e): e is BaselineTrashEntry => e !== null)
      .filter((e) => now - e.deletedAt < BASELINE_TRASH_TTL_MS);
    list.sort((a, b) => b.deletedAt - a.deletedAt);
    return list.slice(0, BASELINE_TRASH_LIMIT);
  } catch {
    return [];
  }
}

async function saveBaselineTrash(
  list: BaselineTrashEntry[],
  by: string | null,
): Promise<void> {
  const capped = list
    .slice()
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, BASELINE_TRASH_LIMIT);
  await setSystemSetting(
    BASELINE_TRASH_KEY,
    JSON.stringify(capped),
    by ?? undefined,
  );
}

const COMPARISON_KEYS: Array<{
  key: string;
  label: string;
  /** When `lower` is true, a lower current value is "better". */
  lower: boolean;
}> = [
  { key: "apiUnknownPct", label: "api pool unknownPct", lower: true },
  { key: "workerUnknownPct", label: "worker pool unknownPct", lower: true },
  { key: "rtP95Ms", label: "DB round-trip p95 (ms)", lower: true },
  { key: "healthSamplesAgeMs", label: "health_samples freshness lag", lower: true },
  { key: "poolStateSamplesAgeMs", label: "pool_state_samples freshness lag", lower: true },
  { key: "newStalledIncidents", label: "new health_sampler_stalled incidents", lower: true },
  { key: "legacySnoozedRows", label: "legacy snoozed incident rows", lower: true },
];

function buildComparison(
  current: Record<string, number | null>,
  baseline: BaselineSnapshot | null,
  acks: Record<string, MetricAcknowledgement> = {},
): ComparisonRow[] {
  if (!baseline) return [];
  return COMPARISON_KEYS.map((c) => {
    const b = baseline.metrics[c.key];
    const cur = current[c.key];
    const baseVal = typeof b === "number" && Number.isFinite(b) ? b : null;
    const curVal = typeof cur === "number" && Number.isFinite(cur) ? cur : null;
    let delta: number | null = null;
    let drift: ComparisonRow["drift"] = "unknown";
    if (baseVal != null && curVal != null) {
      delta = curVal - baseVal;
      if (delta === 0) drift = "same";
      else if (c.lower) drift = delta < 0 ? "better" : "worse";
      else drift = delta > 0 ? "better" : "worse";
    }
    return {
      key: c.key,
      label: c.label,
      baseline: baseVal,
      current: curVal,
      delta,
      drift,
      acknowledgement: acks[c.key] ?? null,
    };
  });
}

// ─── Acknowledgements (Task #1018) ──────────────────────────────────────

type AcknowledgementMap = Record<string, Record<string, MetricAcknowledgement>>;

function normalizeAcknowledgements(raw: any): AcknowledgementMap {
  if (!raw || typeof raw !== "object") return {};
  const out: AcknowledgementMap = {};
  for (const [bucketKey, bucket] of Object.entries(raw)) {
    if (!bucket || typeof bucket !== "object") continue;
    const inner: Record<string, MetricAcknowledgement> = {};
    for (const [metricKey, ack] of Object.entries(bucket as any)) {
      if (!ack || typeof ack !== "object") continue;
      const at = typeof (ack as any).at === "number" ? (ack as any).at : null;
      if (at == null) continue;
      const by =
        typeof (ack as any).by === "string" ? (ack as any).by : null;
      inner[metricKey] = { by, at };
    }
    if (Object.keys(inner).length > 0) out[bucketKey] = inner;
  }
  return out;
}

async function loadAcknowledgements(): Promise<AcknowledgementMap> {
  const setting = await getSystemSetting(ACKNOWLEDGEMENTS_KEY);
  if (!setting?.value) return {};
  try {
    return normalizeAcknowledgements(JSON.parse(setting.value));
  } catch {
    return {};
  }
}

async function saveAcknowledgements(
  map: AcknowledgementMap,
  by: string | null,
): Promise<void> {
  if (Object.keys(map).length === 0) {
    await deleteSystemSetting(ACKNOWLEDGEMENTS_KEY);
    return;
  }
  await setSystemSetting(
    ACKNOWLEDGEMENTS_KEY,
    JSON.stringify(map),
    by ?? undefined,
  );
}

const VALID_METRIC_KEYS = new Set(COMPARISON_KEYS.map((c) => c.key));

export async function acknowledgeMetric(
  baselineId: number,
  metricKey: string,
  by: string | null,
): Promise<{ ok: true; acknowledgement: MetricAcknowledgement } | { ok: false; error: string }> {
  if (!Number.isFinite(baselineId)) return { ok: false, error: "Invalid baselineId" };
  if (!VALID_METRIC_KEYS.has(metricKey)) {
    return { ok: false, error: "Unknown metric key" };
  }
  const history = await loadBaselineHistory();
  if (!history.some((b) => b.id === baselineId)) {
    return { ok: false, error: "Baseline not found in history" };
  }
  const map = await loadAcknowledgements();
  const bucketKey = String(baselineId);
  const ack: MetricAcknowledgement = { by, at: Date.now() };
  map[bucketKey] = { ...(map[bucketKey] ?? {}), [metricKey]: ack };
  await saveAcknowledgements(map, by);
  return { ok: true, acknowledgement: ack };
}

export async function unacknowledgeMetric(
  baselineId: number,
  metricKey: string,
  by: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(baselineId)) return { ok: false, error: "Invalid baselineId" };
  const map = await loadAcknowledgements();
  const bucketKey = String(baselineId);
  const bucket = map[bucketKey];
  if (!bucket || !(metricKey in bucket)) return { ok: true };
  delete bucket[metricKey];
  if (Object.keys(bucket).length === 0) delete map[bucketKey];
  await saveAcknowledgements(map, by);
  return { ok: true };
}

async function clearAllAcknowledgements(by: string | null): Promise<void> {
  await saveAcknowledgements({}, by);
}

async function clearAcknowledgementsForBaseline(
  baselineId: number,
  by: string | null,
): Promise<void> {
  const map = await loadAcknowledgements();
  const bucketKey = String(baselineId);
  if (!(bucketKey in map)) return;
  delete map[bucketKey];
  await saveAcknowledgements(map, by);
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function runPostDeployVerification(opts?: {
  /** Task #983 — pick which baseline to compare against (defaults to most recent). */
  baselineId?: number | null;
}): Promise<VerificationReport> {
  const now = Date.now();
  const baselines = await loadBaselineHistory();
  const requestedId = opts?.baselineId ?? null;
  // If a requested ID has rolled off the capped history, transparently
  // fall back to the most recent baseline so the panel still renders a
  // useful comparison instead of an empty section.
  const baseline =
    (requestedId != null
      ? baselines.find((b) => b.id === requestedId) ?? baselines[0]
      : baselines[0]) ?? null;
  // "Post-deploy window" = since the most recent saved baseline (used to
  // size the gap-scan window), or 1h fallback. Always anchored to the
  // newest baseline regardless of which one the operator is comparing
  // against, so the checklist itself doesn't shift when picking a
  // historical entry from the dropdown.
  const newestBaselineAt = baselines[0]?.savedAt ?? null;
  const postDeployWindowStart =
    newestBaselineAt && newestBaselineAt > now - 24 * 60 * 60_000
      ? newestBaselineAt
      : now - 60 * 60_000;

  const [samplerGroup, incidentGroup, attribution, healthMetric] = await Promise.all([
    checkSamplers(now, postDeployWindowStart),
    checkIncidents(now),
    checkAttribution(),
    checkHealthMetrics(postDeployWindowStart),
  ]);

  // Pull numerics back out of the check rows so the comparison view has
  // a single source of truth.
  const numFromCheck = (group: CheckGroup, id: string): number | null => {
    const row = group.checks.find((c) => c.id === id);
    return row?.numeric == null ? null : Number(row.numeric);
  };

  const metrics: Record<string, number | null> = {
    apiUnknownPct: attribution.apiUnknownPct,
    workerUnknownPct: attribution.workerUnknownPct,
    rtP95Ms: healthMetric.rtP95Ms,
    healthSamplesAgeMs: numFromCheck(samplerGroup, "health_samples_fresh"),
    poolStateSamplesAgeMs: numFromCheck(samplerGroup, "pool_state_samples_fresh"),
    newStalledIncidents: numFromCheck(samplerGroup, "no_new_stalled_incidents"),
    legacySnoozedRows: numFromCheck(incidentGroup, "no_legacy_snoozed"),
  };

  const groups = [samplerGroup, incidentGroup, attribution.group, healthMetric.group];
  const overall = aggregate(groups.map((g) => g.status));
  const acks = await loadAcknowledgements();
  const comparison = buildComparison(
    metrics,
    baseline,
    baseline ? acks[String(baseline.id)] ?? {} : {},
  );
  const autoBaseline = { enabled: await getAutoBaselineEnabled() };
  const baselineTrash = await loadBaselineTrash(now);

  return {
    generatedAt: now,
    overall,
    groups,
    baseline,
    baselines,
    comparison,
    metrics,
    autoBaseline,
    baselineTrash,
  };
}

// ─── Auto-baseline (Task #974) ──────────────────────────────────────────

/** True when the boot-time auto-snapshot is enabled (default: enabled). */
export async function getAutoBaselineEnabled(): Promise<boolean> {
  const setting = await getSystemSetting(AUTO_BASELINE_DISABLED_KEY);
  // Stored as the literal string "true" when the operator has disabled it;
  // any other value (including missing) means auto-snapshot is on.
  return setting?.value !== "true";
}

export async function setAutoBaselineEnabled(
  enabled: boolean,
  by: string | null,
): Promise<{ enabled: boolean }> {
  await setSystemSetting(
    AUTO_BASELINE_DISABLED_KEY,
    enabled ? "false" : "true",
    by ?? undefined,
  );
  return { enabled };
}

/**
 * Run the verification checklist and, if it passes overall and the
 * auto-snapshot toggle is enabled, persist the metrics as the new baseline
 * with `savedBy = AUTO_BASELINE_SAVED_BY`. Used by the boot-time scheduler.
 */
export async function tryAutoSnapshotBaseline(): Promise<{
  attempted: boolean;
  saved: boolean;
  reason: string;
  overall?: CheckStatus;
}> {
  const enabled = await getAutoBaselineEnabled();
  if (!enabled) {
    return { attempted: false, saved: false, reason: "auto-snapshot disabled" };
  }
  const report = await runPostDeployVerification();
  if (report.overall !== "pass") {
    const reason = `overall status was ${report.overall}, baseline not saved`;
    // Task #984 — surface a one-shot alert so a degraded deploy doesn't
    // leave the baseline silently stale. The dispatcher honors a persisted
    // cooldown so a flapping deploy doesn't spam the channel.
    try {
      const failingGroups = report.groups
        .filter((g) => g.status !== "pass")
        .map((g) => ({
          id: g.id,
          title: g.title,
          status: g.status as "warn" | "fail",
        }));
      const { recordAutoBaselineSkip } = await import(
        "./autoBaselineSkipAlerts"
      );
      await recordAutoBaselineSkip({
        overall: report.overall as "warn" | "fail",
        failingGroups,
        reason,
      });
    } catch (err: any) {
      console.warn(
        "[PostDeployVerification] auto-baseline skip alert failed:",
        err?.message ?? err,
      );
    }
    return {
      attempted: true,
      saved: false,
      reason,
      overall: report.overall,
    };
  }
  // Pass the already-computed report through so the persisted metrics are
  // the exact values the pass-gate just inspected (no second verification run).
  await snapshotBaseline(AUTO_BASELINE_SAVED_BY, report);
  return {
    attempted: true,
    saved: true,
    reason: "baseline auto-saved",
    overall: report.overall,
  };
}

/**
 * Schedule a single boot-time auto-snapshot attempt after the warmup window.
 * Returns the timer handle so the caller can register it with the bootstrap
 * timer-tracking helper. Safe to call multiple times — each call schedules
 * one independent attempt; callers should only invoke once per boot.
 */
export function scheduleAutoBaselineSnapshot(opts?: {
  delayMs?: number;
  isShutdown?: () => boolean;
}): ReturnType<typeof setTimeout> {
  const delayMs = opts?.delayMs ?? AUTO_BASELINE_BOOT_DELAY_MS;
  const isShutdown = opts?.isShutdown ?? (() => false);
  return setTimeout(async () => {
    if (isShutdown()) return;
    try {
      const result = await tryAutoSnapshotBaseline();
      if (result.saved) {
        console.log(
          `[PostDeployVerification] auto-baseline saved (overall=${result.overall})`,
        );
      } else {
        console.log(
          `[PostDeployVerification] auto-baseline skipped: ${result.reason}`,
        );
      }
    } catch (err: any) {
      console.warn(
        "[PostDeployVerification] auto-baseline attempt failed:",
        err?.message ?? err,
      );
    }
  }, delayMs);
}

/**
 * Task #1004 — remove a single baseline from the rolling history. Returns
 * `true` when an entry matching `id` was found and removed, `false` otherwise.
 * The legacy single-row `BASELINE_KEY` setting is kept in sync with the new
 * newest entry so older readers see a consistent value.
 *
 * Task #1007 — the removed snapshot is also pushed onto the short-lived
 * baseline trash (capped at 5 entries / 24h) so an operator who deleted the
 * wrong row can restore it via `restoreBaseline`.
 */
export async function deleteBaseline(
  id: number,
  by: string | null,
): Promise<boolean> {
  const history = await loadBaselineHistory();
  const removed = history.find((b) => b.id === id);
  const next = history.filter((b) => b.id !== id);
  if (next.length === history.length || !removed) return false;
  await saveBaselineHistory(next, by);
  if (next.length > 0) {
    await setSystemSetting(
      BASELINE_KEY,
      JSON.stringify(next[0]),
      by ?? undefined,
    );
  } else {
    await deleteSystemSetting(BASELINE_KEY);
  }
  // Soft-delete: drop into the trash so it can be restored within 24h.
  // Any prior trash entry for the same baseline id is dropped first so the
  // newest deletion wins.
  const now = Date.now();
  const trash = (await loadBaselineTrash(now)).filter(
    (e) => e.snapshot.id !== id,
  );
  trash.unshift({ snapshot: removed, deletedAt: now, deletedBy: by });
  await saveBaselineTrash(trash, by);
  // Task #1018 — drop acknowledgements tied to the removed baseline so they
  // don't leak forward if the same numeric id is ever reused.
  await clearAcknowledgementsForBaseline(id, by);
  return true;
}

/**
 * Task #1007 — restore a baseline previously moved to the trash. Returns
 * the restored snapshot when found (and re-inserted into history), or `null`
 * when no live trash entry matches `id` (already expired, never deleted, or
 * pruned beyond the 5-entry cap). Restoring respects the rolling history
 * cap and re-syncs the legacy single-row `BASELINE_KEY` whenever the
 * restored entry becomes the newest.
 */
export async function restoreBaseline(
  id: number,
  by: string | null,
): Promise<BaselineSnapshot | null> {
  const now = Date.now();
  const trash = await loadBaselineTrash(now);
  const entry = trash.find((e) => e.snapshot.id === id);
  if (!entry) return null;
  const remainingTrash = trash.filter((e) => e.snapshot.id !== id);
  await saveBaselineTrash(remainingTrash, by);

  const history = await loadBaselineHistory();
  // De-dupe in case a baseline with the same id was somehow re-snapshotted
  // while this one sat in the trash.
  const merged = [
    entry.snapshot,
    ...history.filter((b) => b.id !== entry.snapshot.id),
  ];
  merged.sort((a, b) => b.savedAt - a.savedAt);
  const next = merged.slice(0, BASELINE_HISTORY_LIMIT);
  await saveBaselineHistory(next, by);
  // If the restored entry is now the newest (or the only one), keep the
  // legacy single-row key in sync just like `snapshotBaseline` does.
  if (next.length > 0 && next[0].id === entry.snapshot.id) {
    await setSystemSetting(
      BASELINE_KEY,
      JSON.stringify(next[0]),
      by ?? undefined,
    );
  }
  return entry.snapshot;
}

export async function snapshotBaseline(
  by: string | null,
  /**
   * Optional pre-computed report — when provided, the baseline is persisted
   * from this exact snapshot instead of re-running verification. Used by the
   * boot-time auto-snapshot path so the metrics stored as the baseline are
   * the same ones the pass-gate just inspected.
   */
  report?: VerificationReport,
): Promise<BaselineSnapshot> {
  const r = report ?? (await runPostDeployVerification());
  const snapshot: BaselineSnapshot = {
    id: r.generatedAt,
    savedAt: r.generatedAt,
    savedBy: by ?? null,
    metrics: r.metrics,
    overallStatus: r.overall,
  };
  // Task #983 — append to rolling history (capped, newest first).
  const history = await loadBaselineHistory();
  const next = [snapshot, ...history.filter((b) => b.id !== snapshot.id)].slice(
    0,
    BASELINE_HISTORY_LIMIT,
  );
  await saveBaselineHistory(next, by);
  // Keep the legacy single-row key in sync so any older code path / external
  // tooling that still reads `BASELINE_KEY` sees the latest snapshot.
  await setSystemSetting(BASELINE_KEY, JSON.stringify(snapshot), by ?? undefined);
  // Task #1018 — saving a new baseline invalidates every previous
  // acknowledgement (the comparison surface is now different).
  await clearAllAcknowledgements(by);
  return snapshot;
}

export interface ForceResolveResult {
  resolved: number;
  details: Array<{ id: number; fingerprint: string; previousStatus: string }>;
}

/**
 * Close the documented legacy stuck incidents:
 *   - the original `db_latency:warning:probe` row, IF it has been quiet
 *     for longer than the 15-minute grace window described in the runbook
 *     (otherwise the resolver is correctly holding it open).
 *   - any leftover `status='snoozed'` rows the boot normalizer missed.
 *
 * This is the one-click escape hatch §8 step (913F.2 last bullet) — admins
 * should still investigate why the auto-resolver did not close the row.
 */
export async function forceResolveLegacyStuckIncidents(
  by: string | null,
): Promise<ForceResolveResult> {
  const out: ForceResolveResult = { resolved: 0, details: [] };
  const now = Date.now();

  // (1) legacy probe row, only if past grace window
  try {
    const r = await db.execute<any>(sql`
      SELECT id, status,
             EXTRACT(EPOCH FROM NOW())*1000 - last_seen_at AS age_ms
        FROM health_incidents
       WHERE fingerprint = ${LEGACY_PROBE_FINGERPRINT}
         AND status IN ('firing','acknowledged','snoozed')
       ORDER BY id DESC
       LIMIT 1
    `);
    const list = Array.isArray(r) ? r : (r as any).rows ?? [];
    const row = list[0];
    if (row && Number(row.age_ms ?? 0) >= LEGACY_PROBE_GRACE_MS) {
      const updated = await resolveIncident(Number(row.id), by ?? "post-deploy-force");
      if (updated && updated.status === "resolved") {
        out.resolved++;
        out.details.push({
          id: Number(row.id),
          fingerprint: LEGACY_PROBE_FINGERPRINT,
          previousStatus: String(row.status),
        });
      }
    }
  } catch (err: any) {
    console.warn("[PostDeployVerification] legacy probe resolve failed:", err?.message ?? err);
  }

  // (2) leftover legacy snoozed rows
  try {
    const stale = await listIncidents({ statuses: ["snoozed"], limit: 200 });
    for (const inc of stale) {
      // Defensive: only force-close ones quiet for >RESOLVE_AFTER_QUIET_MS (10m)
      if (now - inc.lastSeenAt < 10 * 60_000) continue;
      const updated = await resolveIncident(inc.id, by ?? "post-deploy-force");
      if (updated && updated.status === "resolved") {
        out.resolved++;
        out.details.push({
          id: inc.id,
          fingerprint: inc.fingerprint,
          previousStatus: "snoozed",
        });
      }
    }
  } catch (err: any) {
    console.warn(
      "[PostDeployVerification] legacy snoozed resolve failed:",
      err?.message ?? err,
    );
  }

  return out;
}

// Test-only helpers
export const __test = {
  BASELINE_KEY,
  BASELINE_HISTORY_KEY,
  BASELINE_HISTORY_LIMIT,
  BASELINE_TRASH_KEY,
  BASELINE_TRASH_LIMIT,
  BASELINE_TRASH_TTL_MS,
  AUTO_BASELINE_DISABLED_KEY,
  ACKNOWLEDGEMENTS_KEY,
  LEGACY_PROBE_FINGERPRINT,
  LEGACY_PROBE_GRACE_MS,
  loadBaselineHistory,
  loadBaselineTrash,
  loadAcknowledgements,
};

export { loadBaselineHistory, loadBaselineTrash };
