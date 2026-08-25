/**
 * Task #861 Phase 6 + 7 — SLO/Error Budget overview and baseline regression.
 *
 * Computes:
 *  - 24h / 7d / 30d ok/degraded/error percentages
 *  - DB round-trip and probe-connect p95/p99
 *  - SLO target (default 99.5%) with 30d error budget remaining
 *  - Baseline-aware regression delta (current 24h vs prior 7d p95)
 *  - Incident counts (open + last 24h)
 *
 * Uses persisted samples for the long-window rates (cheap with the new
 * indexes; daily rollups are preferred for very long windows when present).
 */

// Task #1573 (Audit Track C): runs on background timers / admin polling,
// not in the request path — keep the api pool free for user requests.
import { readFileSync } from "node:fs";
import { workerDb as db } from "../db";
import { sql, gte, and, eq } from "drizzle-orm";
import { healthSamples, healthDailyRollups, healthIncidents } from "@shared/schema";
import { getSupervisedSamplerStates } from "./supervisedSampler";

const WINDOW_24H_MS = 24 * 60 * 60_000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60_000;
const WINDOW_30D_MS = 30 * 24 * 60 * 60_000;

const DEFAULT_TARGET_PCT = 99.5;
// Spec: alert when current 24h p95 is at least 50% worse than the prior 7-day p95.
const DEFAULT_REGRESSION_FACTOR = 0.50;

export interface WindowSummary {
  sampleCount: number;
  okPct: number;
  degradedPct: number;
  errorPct: number;
}

/**
 * Task #992 — canonical health-state thresholds.
 *
 * The status pipeline classifies into 4 states from two independent
 * inputs: (a) the supervised-sampler runtime heartbeat for the
 * `health_samples` writer (so we know whether the system can even
 * report on itself), and (b) the latest persisted `health_samples` row
 * status (the actual DB-probe verdict).
 *
 *  - `unknown`  — no successful heartbeat yet (startup grace) OR the
 *                 latest persisted sample is older than UNKNOWN_AGE.
 *  - `error`    — sampler has an open stall incident, or the latest
 *                 persisted row is `error`, or the writer has been
 *                 silent past CRITICAL_STALE.
 *  - `degraded` — sampler is in soft-stall (≥1 missed heartbeat below
 *                 the open threshold), or the latest persisted row is
 *                 `degraded`.
 *  - `ok`       — heartbeat is fresh and the latest row is `ok`.
 */
const UNKNOWN_STATUS_MAX_AGE_MS = 5 * 60_000;
const CRITICAL_STALE_MS = 15 * 60_000;
const SAMPLER_WRITER_NAME = "health_samples";

export interface OverviewResult {
  generatedAt: number;
  currentStatus: "ok" | "degraded" | "error" | "unknown";
  /**
   * Epoch-ms timestamp of the latest persisted health sample, if any.
   * Surfaced so the UI can render "last updated Xs ago" and reconcile
   * the heartbeat against the watchdog state without a second round-trip.
   */
  latestSampleAt: number | null;
  windows: { h24: WindowSummary; d7: WindowSummary; d30: WindowSummary };
  slo: {
    errorBudgetTargetPct: number;
    errorBudgetUsedPct: number;
    errorBudgetRemainingPct: number;
    /**
     * Task #992 — `errorBudgetUsedPct` is the **canonical**
     * confirmed-DB-outage budget consumption: it is computed from a
     * 30-day error rate that has the writer's own stall time
     * subtracted (per-window, no extrapolation). `errorBudgetUsedPctRaw`
     * exposes the un-discounted value for transparency only;
     * dashboards should display the canonical value.
     */
    errorBudgetUsedPctRaw: number;
    samplerStaleSecondsLast24h: number;
    samplerStaleSecondsLast7d: number;
    samplerStaleSecondsLast30d: number;
    /** 30-day DB error % with writer stall time subtracted (canonical). */
    confirmedErrorPct30d: number;
    /** 30-day raw DB error % including writer stall time. */
    rawErrorPct30d: number;
  };
  /**
   * Task #992 — surfaces the supervised-sampler runtime view that
   * drove `currentStatus`, so the dashboard can render a single
   * coherent verdict without a second round-trip.
   */
  sampler: {
    name: string;
    healthy: boolean;
    inFlight: boolean;
    consecutiveMisses: number;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    secondsSinceLastSuccess: number | null;
    unhealthyReason: string | null;
    hasOpenStallIncident: boolean;
  } | null;
  latency: {
    roundTripP95Ms: number | null;
    roundTripP99Ms: number | null;
    dbProbeP95Ms: number | null;
    dbProbeP99Ms: number | null;
  };
  regression: {
    metric: string;
    currentP95: number;
    baselineP95: number;
    deltaPct: number;
    isRegression: boolean;
    summary: string;
  } | null;
  incidents: { openCount: number; last24hCount: number };
  /**
   * Task #4501 — regression-sweep and baseline health for the team-lead panel.
   * Populated from cheap disk reads; absent/unreadable files yield null fields.
   * Optional so callers that don't need it can ignore the field gracefully.
   */
  regressionSweep?: {
    /** publishedAt stamp from tests/green-baseline.json */
    baselinePublishedAt: string | null;
    /** Age in days of the committed green baseline; null when absent or unparseable. */
    baselineAgeDays: number | null;
    /** Most-recent publish stamp from tests/red-manifest.json (publishedAt or lastPartialUpdateAt). */
    redManifestPublishedAt: string | null;
    /** Age in days of the red manifest stamp; null when absent or unparseable. */
    redManifestAgeDays: number | null;
    /** finishedAt from the last sweep tick (.local/state/regression-sweep-last-tick.json). */
    lastSweepFinishedAt: string | null;
  };
}

export interface OverviewOptions {
  monthlyTargetPct?: number;
  regressionFactor?: number;
}

async function summarizeWindow(sinceMs: number, untilMs: number): Promise<WindowSummary> {
  const r = await db.execute<any>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'ok')::int AS ok,
      COUNT(*) FILTER (WHERE status = 'degraded')::int AS degraded,
      COUNT(*) FILTER (WHERE status = 'error')::int AS errored
    FROM health_samples
    WHERE timestamp >= ${sinceMs} AND timestamp < ${untilMs}
  `);
  const list = Array.isArray(r) ? r : (r as any).rows ?? [];
  const row = list[0] ?? { total: 0, ok: 0, degraded: 0, errored: 0 };
  const total = Number(row.total ?? 0);
  if (total === 0) {
    return { sampleCount: 0, okPct: 0, degradedPct: 0, errorPct: 0 };
  }
  return {
    sampleCount: total,
    okPct: (Number(row.ok ?? 0) / total) * 100,
    degradedPct: (Number(row.degraded ?? 0) / total) * 100,
    errorPct: (Number(row.errored ?? 0) / total) * 100,
  };
}

async function percentiles(sinceMs: number, untilMs: number): Promise<{
  rtP95: number | null;
  rtP99: number | null;
  cP95: number | null;
  cP99: number | null;
}> {
  const r = await db.execute<any>(sql`
    SELECT
      PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY db_round_trip_ms) AS rt_p95,
      PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY db_round_trip_ms) AS rt_p99,
      PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY db_probe_connect_ms) AS c_p95,
      PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY db_probe_connect_ms) AS c_p99
    FROM health_samples
    WHERE timestamp >= ${sinceMs} AND timestamp < ${untilMs}
  `);
  const list = Array.isArray(r) ? r : (r as any).rows ?? [];
  const row = list[0] ?? {};
  return {
    rtP95: row.rt_p95 !== null && row.rt_p95 !== undefined ? Number(row.rt_p95) : null,
    rtP99: row.rt_p99 !== null && row.rt_p99 !== undefined ? Number(row.rt_p99) : null,
    cP95: row.c_p95 !== null && row.c_p95 !== undefined ? Number(row.c_p95) : null,
    cP99: row.c_p99 !== null && row.c_p99 !== undefined ? Number(row.c_p99) : null,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Task #992 — sum the duration (in seconds) of any open or
 * recently-resolved `health_sampler_stalled` incidents whose origin is
 * the writer sampler, *clipped to a specific window*. This represents
 * time during which the *writer* (not the DB) was unhealthy. We use
 * the per-window result to discount that window's SLO error budget so
 * a flapping writer does not consume the budget reserved for confirmed
 * DB outages — and we do it correctly per window (no 24h-to-30d
 * extrapolation).
 */
async function computeSamplerStaleSecondsForWindow(
  now: number,
  windowMs: number,
): Promise<number> {
  const since = now - windowMs;
  try {
    const r = await db.execute<any>(sql`
      SELECT
        first_seen_at,
        COALESCE(resolved_at, last_seen_at) AS end_at
      FROM health_incidents
      WHERE metric = 'health_sampler_stalled'
        AND origin = ${SAMPLER_WRITER_NAME}
        AND COALESCE(resolved_at, last_seen_at) >= ${since}
    `);
    const list = Array.isArray(r) ? r : (r as any).rows ?? [];
    let totalMs = 0;
    for (const row of list) {
      const start = Math.max(Number(row.first_seen_at ?? 0), since);
      const end = Math.min(Number(row.end_at ?? now), now);
      if (end > start) totalMs += end - start;
    }
    return Math.round(totalMs / 1000);
  } catch {
    return 0;
  }
}

async function countIncidents(sinceMs: number): Promise<{ openCount: number; last24hCount: number }> {
  try {
    const [openR, lastR] = await Promise.all([
      // Include legacy `snoozed` (pre-913D) so pre-existing rows still
      // surface as "open" until the startup normalizer rewrites them.
      db.execute<any>(sql`SELECT COUNT(*)::int AS c FROM health_incidents WHERE status IN ('firing', 'acknowledged', 'snoozed')`),
      db.execute<any>(sql`SELECT COUNT(*)::int AS c FROM health_incidents WHERE last_seen_at >= ${sinceMs}`),
    ]);
    const openRows = Array.isArray(openR) ? openR : (openR as any).rows ?? [];
    const lastRows = Array.isArray(lastR) ? lastR : (lastR as any).rows ?? [];
    return {
      openCount: Number(openRows[0]?.c ?? 0),
      last24hCount: Number(lastRows[0]?.c ?? 0),
    };
  } catch {
    return { openCount: 0, last24hCount: 0 };
  }
}

export async function computeOverview(opts: OverviewOptions = {}): Promise<OverviewResult> {
  const target = opts.monthlyTargetPct ?? DEFAULT_TARGET_PCT;
  const regressionFactor = opts.regressionFactor ?? DEFAULT_REGRESSION_FACTOR;
  const now = Date.now();
  const since24h = now - WINDOW_24H_MS;
  const since7d = now - WINDOW_7D_MS;
  const since30d = now - WINDOW_30D_MS;

  const [h24, d7, d30, latency, baselineLatency, incidentCounts] = await Promise.all([
    summarizeWindow(since24h, now),
    summarizeWindow(since7d, now),
    summarizeWindow(since30d, now),
    percentiles(since24h, now),
    percentiles(since7d, since24h), // prior 7-day window (excluding last 24h)
    countIncidents(since24h),
  ]);

  // Task #992 — canonical health-state classification.
  //
  // Combine two independent inputs:
  //   1. Supervised-sampler runtime heartbeat for the writer that
  //      produces `health_samples` rows (tells us whether the system
  //      can even report on itself).
  //   2. Latest persisted `health_samples` row status (the actual
  //      DB-probe verdict from the most recent successful tick).
  //
  // This is intentionally NOT just "newest persisted row's status with
  // an age cutoff" — that approach can show "ok" while the writer is
  // hung, and "unknown" while the DB itself is genuinely down.
  let latestRowStatus: "ok" | "degraded" | "error" | null = null;
  let latestSampleAt: number | null = null;
  try {
    const r = await db
      .select({ status: healthSamples.status, timestamp: healthSamples.timestamp })
      .from(healthSamples)
      .orderBy(sql`timestamp DESC`)
      .limit(1);
    if (r.length > 0) {
      latestSampleAt = Number(r[0].timestamp ?? 0) || null;
      latestRowStatus = (r[0].status as any) ?? null;
    }
  } catch {
    /* leave defaults */
  }

  // Pull the writer sampler's runtime state and check for an open
  // stall incident keyed on its origin.
  const samplerStates = (() => {
    try {
      return getSupervisedSamplerStates();
    } catch {
      return [];
    }
  })();
  const writerState =
    samplerStates.find((s) => s.name === SAMPLER_WRITER_NAME) ?? null;
  let hasOpenStallIncident = false;
  try {
    const r = await db.execute<any>(sql`
      SELECT 1 FROM health_incidents
      WHERE metric = 'health_sampler_stalled'
        AND origin = ${SAMPLER_WRITER_NAME}
        AND status IN ('firing', 'acknowledged', 'snoozed')
      LIMIT 1
    `);
    const list = Array.isArray(r) ? r : (r as any).rows ?? [];
    hasOpenStallIncident = list.length > 0;
  } catch {
    /* leave default */
  }

  const sampleAgeMs = latestSampleAt ? now - latestSampleAt : Infinity;
  const heartbeatAgeMs = writerState?.lastTickSucceededAt
    ? now - writerState.lastTickSucceededAt
    : Infinity;
  const inStartupGrace =
    !!writerState && writerState.lastTickSucceededAt === null;

  // Task #992 — 4-state classification contract:
  //   • `unknown`  — only when we have no usable signal: startup grace
  //                  (writer registered but never succeeded) OR no
  //                  persisted sample row exists yet.
  //   • `error`    — open stall incident, latest row status='error',
  //                  OR heartbeat older than CRITICAL_STALE_MS.
  //   • `degraded` — latest row status='degraded', writer has a
  //                  miss/failure streak below the open-incident
  //                  thresholds, OR the persisted sample is late but
  //                  still within tolerance (older than the "fresh"
  //                  threshold but younger than CRITICAL_STALE_MS).
  //   • `ok`       — latest row says ok and the writer is healthy.
  // Status precedence (post-startup-grace):
  //   error > degraded > ok > unknown(no-signal)
  // A confirmed sampler stall must always surface as `error`, even
  // when there is no persisted sample row yet, so operators are not
  // blinded by a "no-signal" classification while the writer is
  // demonstrably stuck. Startup grace remains its own dedicated
  // unknown state.
  let currentStatus: "ok" | "degraded" | "error" | "unknown";
  if (inStartupGrace) {
    currentStatus = "unknown";
  } else if (
    hasOpenStallIncident ||
    latestRowStatus === "error" ||
    heartbeatAgeMs > CRITICAL_STALE_MS
  ) {
    currentStatus = "error";
  } else if (!latestRowStatus) {
    // Past startup grace, no error condition, but no persisted sample
    // either — genuinely no-signal.
    currentStatus = "unknown";
  } else if (
    latestRowStatus === "degraded" ||
    sampleAgeMs > UNKNOWN_STATUS_MAX_AGE_MS ||
    (writerState &&
      (writerState.consecutiveMisses > 0 ||
        writerState.consecutiveFailures > 0))
  ) {
    currentStatus = "degraded";
  } else {
    currentStatus = latestRowStatus; // "ok"
  }

  // Task #992 — SLO separation, computed *per window* (no
  // 24h-to-30d extrapolation). For each window we measure how many
  // seconds of writer stall fell inside that exact window, convert
  // to a percentage of that window's wall-clock duration, and
  // subtract from that window's raw error rate. The 30d value is
  // the canonical SLO budget input.
  const [
    samplerStaleSecondsLast24h,
    samplerStaleSecondsLast7d,
    samplerStaleSecondsLast30d,
  ] = await Promise.all([
    computeSamplerStaleSecondsForWindow(now, WINDOW_24H_MS),
    computeSamplerStaleSecondsForWindow(now, WINDOW_7D_MS),
    computeSamplerStaleSecondsForWindow(now, WINDOW_30D_MS),
  ]);
  const samplerStalePct30d = clamp(
    (samplerStaleSecondsLast30d / (WINDOW_30D_MS / 1000)) * 100,
    0,
    100,
  );
  const rawErrorPct30d = d30.errorPct;
  const confirmedErrorPct30d = Math.max(0, rawErrorPct30d - samplerStalePct30d);

  const allowedErrorPct = 100 - target;
  // Canonical SLO budget consumption uses the *confirmed-DB-outage*
  // rate (writer stall subtracted). Raw is preserved for transparency.
  const errorBudgetUsedPct = allowedErrorPct > 0
    ? Math.min(100, (confirmedErrorPct30d / allowedErrorPct) * 100)
    : 0;
  const errorBudgetUsedPctRaw = allowedErrorPct > 0
    ? Math.min(100, (rawErrorPct30d / allowedErrorPct) * 100)
    : 0;
  const errorBudgetRemainingPct = Math.max(0, 100 - errorBudgetUsedPct);

  const baselineP95 = baselineLatency.rtP95;
  const currentP95 = latency.rtP95;
  let regression: OverviewResult["regression"] = null;
  if (currentP95 !== null && baselineP95 !== null && baselineP95 > 0) {
    const deltaPct = ((currentP95 - baselineP95) / baselineP95) * 100;
    const isRegression = deltaPct >= regressionFactor * 100;
    regression = {
      metric: "db_round_trip_ms",
      currentP95,
      baselineP95,
      deltaPct,
      isRegression,
      summary: isRegression
        ? `db_round_trip_ms p95 ${currentP95}ms is ${deltaPct.toFixed(1)}% worse than 7-day baseline ${baselineP95}ms (regression).`
        : `db_round_trip_ms p95 ${currentP95}ms vs 7-day baseline ${baselineP95}ms (Δ ${deltaPct.toFixed(1)}%).`,
    };
  }

  return {
    generatedAt: now,
    currentStatus,
    latestSampleAt,
    windows: { h24, d7, d30 },
    slo: {
      errorBudgetTargetPct: target,
      errorBudgetUsedPct,
      errorBudgetRemainingPct,
      errorBudgetUsedPctRaw,
      samplerStaleSecondsLast24h,
      samplerStaleSecondsLast7d,
      samplerStaleSecondsLast30d,
      confirmedErrorPct30d,
      rawErrorPct30d,
    },
    sampler: writerState
      ? {
          name: writerState.name,
          healthy: writerState.healthy,
          inFlight: writerState.inFlight,
          consecutiveMisses: writerState.consecutiveMisses,
          consecutiveFailures: writerState.consecutiveFailures,
          consecutiveSuccesses: writerState.consecutiveSuccesses,
          secondsSinceLastSuccess: writerState.lastTickSucceededAt
            ? Math.round(
                (now - writerState.lastTickSucceededAt) / 1000,
              )
            : null,
          unhealthyReason: writerState.unhealthyReason,
          hasOpenStallIncident,
        }
      : null,
    latency: {
      roundTripP95Ms: latency.rtP95,
      roundTripP99Ms: latency.rtP99,
      dbProbeP95Ms: latency.cP95,
      dbProbeP99Ms: latency.cP99,
    },
    regression,
    incidents: incidentCounts,
    regressionSweep: (() => {
      // Task #4501 — cheap disk reads, never throw into the overview computation.
      try {
        // Green baseline publishedAt.
        let baselinePublishedAt: string | null = null;
        let baselineAgeDays: number | null = null;
        try {
          const bl = JSON.parse(readFileSync("tests/green-baseline.json", "utf8")) as { publishedAt?: unknown } | null;
          baselinePublishedAt = bl && typeof bl.publishedAt === "string" ? bl.publishedAt : null;
          if (baselinePublishedAt) {
            const t = Date.parse(baselinePublishedAt);
            if (Number.isFinite(t)) baselineAgeDays = (now - t) / (24 * 60 * 60_000);
          }
        } catch { /* baseline absent → nulls */ }

        // Red manifest — use publishedAt if present, fall back to lastPartialUpdateAt
        // (the canary partial-publish timestamp; Task #4501).
        let redManifestPublishedAt: string | null = null;
        let redManifestAgeDays: number | null = null;
        try {
          const rm = JSON.parse(readFileSync("tests/red-manifest.json", "utf8")) as {
            publishedAt?: unknown;
            lastPartialUpdateAt?: unknown;
          } | null;
          // Use the MOST RECENT of publishedAt (nightly) and lastPartialUpdateAt
          // (post-merge canary, Task #4501). Using ?? would always prefer
          // publishedAt and mask a newer canary update, producing false stale alerts.
          const rmStamps = [
            rm && typeof rm.publishedAt === "string" ? rm.publishedAt : null,
            rm && typeof rm.lastPartialUpdateAt === "string" ? rm.lastPartialUpdateAt : null,
          ].filter((s): s is string => s !== null);
          const stamp =
            rmStamps.length > 0
              ? rmStamps.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))
              : null;
          redManifestPublishedAt = stamp;
          if (stamp) {
            const t = Date.parse(stamp);
            if (Number.isFinite(t)) redManifestAgeDays = (now - t) / (24 * 60 * 60_000);
          }
        } catch { /* manifest absent → nulls */ }

        // Last sweep finished-at from the last-tick state file.
        let lastSweepFinishedAt: string | null = null;
        try {
          const lt = JSON.parse(
            readFileSync(".local/state/regression-sweep-last-tick.json", "utf8"),
          ) as { finishedAt?: unknown } | null;
          lastSweepFinishedAt = lt && typeof lt.finishedAt === "string" ? lt.finishedAt : null;
        } catch { /* absent → null */ }

        // Task #5028 — auto-quarantine ledger count + entries.
        let quarantineCount: number | null = null;
        let quarantineEntries: Array<{ file: string; enteredAt: string }> = [];
        try {
          const ql = JSON.parse(readFileSync("tests/flake-quarantine.json", "utf8")) as {
            entries?: unknown;
          } | null;
          if (ql && Array.isArray(ql.entries)) {
            quarantineCount = ql.entries.length;
            quarantineEntries = (ql.entries as Array<Record<string, unknown>>)
              .filter(
                (e): e is { file: string; enteredAt: string } =>
                  !!e && typeof e.file === "string" && typeof e.enteredAt === "string",
              )
              .map((e) => ({ file: e.file, enteredAt: e.enteredAt }));
          }
        } catch { /* absent = normal bootstrap */ }

        return { baselinePublishedAt, baselineAgeDays, redManifestPublishedAt, redManifestAgeDays, lastSweepFinishedAt, quarantineCount, quarantineEntries };
      } catch {
        return undefined;
      }
    })(),
  };
}

export async function getDailyRollupSeries(days: number): Promise<{
  date: string;
  errorPct: number;
  okPct: number;
  p95: number | null;
}[]> {
  const sinceDate = ((): string => {
    const d = new Date(Date.now() - days * 24 * 60 * 60_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  })();
  const rows = await db
    .select()
    .from(healthDailyRollups)
    .where(and(gte(healthDailyRollups.date, sinceDate), eq(healthDailyRollups.metric, "db_round_trip_ms")))
    .orderBy(healthDailyRollups.date);
  return rows.map((r) => ({
    date: r.date,
    errorPct: r.sampleCount > 0 ? (r.errorCount / r.sampleCount) * 100 : 0,
    okPct: r.sampleCount > 0 ? (r.okCount / r.sampleCount) * 100 : 0,
    p95: r.p95 ?? null,
  }));
}

// Reference healthIncidents to keep import meaningful and avoid linter strip.
export const __schemaRefs = { healthIncidents };
