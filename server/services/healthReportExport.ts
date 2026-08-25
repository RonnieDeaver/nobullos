/**
 * Task #861 Phase 10 — Markdown export of the Health Dashboard.
 *
 * Self-contained 24h or 7d report suitable for ops review notes. Pulls from
 * the same in-memory/cached layers the dashboard reads, so it never issues
 * heavy duplicate queries on its own.
 */

import {
  getPersistedHealthHistory,
  getHealthHistory,
  computeSummaryFromSamples,
  getThresholds,
  type HealthSample,
} from "./healthMetrics";
import { listOpenIncidents, listRecentIncidents } from "./healthIncidents";
import { computeOverview } from "./healthOverview";
import { getFreshness } from "./healthRollups";
import {
  getSlowQueries,
  getLocks,
  getTableHealth,
  getMetricAvailability,
} from "./dbServerMetrics";
import * as healthStore from "../storage/healthMetricsStorage";

export type ReportRange = "24h" | "7d";

const RANGE_MS: Record<ReportRange, number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

function pct(num: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function dateIso(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toISOString();
}

function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value}ms`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function buildHealthReportMarkdown(range: ReportRange): Promise<string> {
  const now = Date.now();
  const since = now - RANGE_MS[range];

  const [persisted, openIncidents, recentIncidents, overview, freshness, slowQ, locks, tables, avail] =
    await Promise.all([
      getPersistedHealthHistory(since).catch(() => [] as HealthSample[]),
      listOpenIncidents().catch(() => []),
      listRecentIncidents(since).catch(() => []),
      computeOverview().catch(() => null),
      getFreshness().catch(() => []),
      getSlowQueries().catch(() => null),
      getLocks().catch(() => null),
      getTableHealth().catch(() => null),
      getMetricAvailability().catch(() => null),
    ]);

  const inMemory = getHealthHistory();
  const persistedTimestamps = new Set(persisted.map((s) => s.timestamp));
  const merged: HealthSample[] = [
    ...persisted,
    ...inMemory.filter((s) => s.timestamp >= since && !persistedTimestamps.has(s.timestamp)),
  ].sort((a, b) => a.timestamp - b.timestamp);

  const summary = computeSummaryFromSamples(merged);
  const thresholds = getThresholds();
  const poolSamples = await healthStore.getPoolStateSamplesSince(since).catch(() => []);
  const apiPoolLast = [...poolSamples].reverse().find((s) => s.poolName === "api");
  const workerPoolLast = [...poolSamples].reverse().find((s) => s.poolName === "worker");

  const lines: string[] = [];
  lines.push(`# Production DB Health Report — ${range}`);
  lines.push("");
  lines.push(`Generated at: ${new Date(now).toISOString()}`);
  lines.push(`Range: ${dateIso(since)} → ${dateIso(now)}`);
  lines.push("");

  // Health overview / SLO
  lines.push("## Health Overview & SLO");
  if (overview) {
    lines.push(`- Current status: **${overview.currentStatus.toUpperCase()}**`);
    lines.push(`- 24h OK: ${overview.windows.h24.okPct.toFixed(1)}% | degraded ${overview.windows.h24.degradedPct.toFixed(1)}% | error ${overview.windows.h24.errorPct.toFixed(1)}%`);
    lines.push(`- 7d OK: ${overview.windows.d7.okPct.toFixed(1)}% | degraded ${overview.windows.d7.degradedPct.toFixed(1)}% | error ${overview.windows.d7.errorPct.toFixed(1)}%`);
    lines.push(`- 30d OK: ${overview.windows.d30.okPct.toFixed(1)}% | degraded ${overview.windows.d30.degradedPct.toFixed(1)}% | error ${overview.windows.d30.errorPct.toFixed(1)}%`);
    lines.push(`- SLO target: ${overview.slo.errorBudgetTargetPct.toFixed(2)}% — Error budget remaining: ${overview.slo.errorBudgetRemainingPct.toFixed(2)}%`);
    lines.push(`- DB round-trip p95: ${ms(overview.latency.roundTripP95Ms)} | p99: ${ms(overview.latency.roundTripP99Ms)}`);
    lines.push(`- DB probe-connect p95: ${ms(overview.latency.dbProbeP95Ms)}`);
    if (overview.regression) {
      lines.push(`- Regression vs prior period: ${overview.regression.summary}`);
    }
  } else {
    lines.push("_overview unavailable_");
  }
  lines.push("");

  // Sample summary
  lines.push("## Sample Summary");
  lines.push(`- Samples in range: ${summary.sampleCount}`);
  if (summary.stats) {
    lines.push(`- Avg DB latency: ${ms(summary.stats.avgDbLatencyMs)}, p95: ${ms(summary.stats.p95DbLatencyMs)}`);
    lines.push(`- Failures: ${summary.stats.dbFailureCount}, degraded: ${summary.stats.degradedCount}, error: ${summary.stats.errorCount}`);
    lines.push(`- API pool wait avg: ${ms(summary.stats.avgApiPoolWaitMs)}, max: ${ms(summary.stats.maxApiPoolWaitMs)}`);
    lines.push(`- Transient DB recoveries (range total): ${summary.stats.transientDbRecoveriesTotal}`);
    // Task #1255: surface the Task #815 proactive recycle counter alongside
    // transient recoveries so the report shows that the lifetime policy is
    // firing as expected.
    lines.push(`- Proactive DB connection recycles (range total): ${summary.stats.connectionRecyclesTotal}`);
  }
  lines.push("");

  // Incidents
  lines.push("## Incidents");
  lines.push(`Open incidents (firing/acknowledged): ${openIncidents.length}`);
  for (const inc of openIncidents.slice(0, 25)) {
    lines.push(
      `- [${inc.severity.toUpperCase()}] ${inc.title} — ${inc.occurrenceCount} occurrences — peak ${inc.peakValue}, latest ${inc.latestValue} — first ${dateIso(inc.firstSeenAt)}, last ${dateIso(inc.lastSeenAt)} — status \`${inc.status}\``,
    );
  }
  lines.push("");
  lines.push(`Recent incidents in range: ${recentIncidents.length}`);
  for (const inc of recentIncidents.slice(0, 50)) {
    lines.push(
      `- ${inc.title} (×${inc.occurrenceCount}) ${inc.status} — last ${dateIso(inc.lastSeenAt)}`,
    );
  }
  lines.push("");

  // Pool state
  lines.push("## Pool State (latest)");
  for (const [name, snap] of [["api", apiPoolLast], ["worker", workerPoolLast]] as const) {
    if (snap) {
      lines.push(`### ${name} pool`);
      lines.push(`- Utilization: ${snap.utilizationPct}% | total ${snap.totalCount} | idle ${snap.idleCount} | waiting ${snap.waitingCount} | max ${snap.maxCount}`);
      lines.push(`- Slow holds (interval): ${snap.slowHoldsInInterval} | unknown labels: ${snap.unknownLabelPct}%`);
      const tops = (snap.topHoldLabels as any)?.byTotalMs ?? [];
      if (tops.length > 0) {
        lines.push("- Top hold labels by total time:");
        for (const t of tops.slice(0, 5)) {
          lines.push(`  - \`${t.label}\` count=${t.count} max=${t.maxMs}ms total=${t.totalMs}ms`);
        }
      }
    } else {
      lines.push(`### ${name} pool`);
      lines.push("_no recent pool sample_");
    }
  }
  lines.push("");

  // Slow queries
  lines.push("## Slow Queries (pg_stat_statements)");
  if (slowQ?.available) {
    for (const q of slowQ.data.slice(0, 10)) {
      lines.push(
        `- calls=${q.calls} total=${q.totalTimeMs}ms mean=${q.meanTimeMs}ms rows=${q.rows} \n  \`\`\`sql\n  ${q.query}\n  \`\`\``,
      );
    }
    if (slowQ.data.length === 0) lines.push("_no rows returned_");
  } else {
    lines.push(`_unavailable: ${slowQ?.unavailableReason ?? "no data"}_`);
  }
  lines.push("");

  // Locks
  lines.push("## Lock Waits (pg_locks)");
  if (locks?.available) {
    for (const l of locks.data.slice(0, 10)) {
      lines.push(`- blocked pid=${l.blockedPid} on relation=${l.relation ?? "—"} for ${l.waitDurationMs}ms`);
    }
    if (locks.data.length === 0) lines.push("_no active lock waits_");
  } else {
    lines.push(`_unavailable: ${locks?.unavailableReason ?? "no data"}_`);
  }
  lines.push("");

  // Table health
  lines.push("## Table Health (pg_stat_user_tables)");
  if (tables?.available) {
    for (const t of tables.data.slice(0, 10)) {
      lines.push(
        `- ${t.schema}.${t.table} — size ${bytes(t.tableSizeBytes)} (idx ${bytes(t.indexSizeBytes)}) | dead ${t.deadTupleRatio}% | last vacuum ${t.lastVacuum ?? "—"} | last analyze ${t.lastAnalyze ?? "—"}`,
      );
    }
  } else {
    lines.push(`_unavailable: ${tables?.unavailableReason ?? "no data"}_`);
  }
  lines.push("");

  // Telemetry freshness
  lines.push("## Telemetry Freshness");
  for (const f of freshness) {
    const note = f.notes ? ` — ${f.notes}` : "";
    lines.push(
      `- \`${f.table}\` — status \`${f.status}\` | last hour ${f.rowsLastHour} rows | 24h ${f.rowsLast24h} rows | last sample ${dateIso(f.lastSampleTimestamp)}${note}`,
    );
  }
  lines.push("");

  // Metric availability
  lines.push("## DB Metric Availability");
  if (avail?.available) {
    for (const a of avail.data) {
      lines.push(`- ${a.feature}: ${a.available ? "OK" : `unavailable — ${a.reason ?? ""}`}`);
    }
  }
  lines.push("");

  // Thresholds
  lines.push("## Thresholds in Effect");
  lines.push("```json");
  lines.push(JSON.stringify(thresholds, null, 2));
  lines.push("```");
  lines.push("");

  // Recommendations
  lines.push("## Suggested Next Investigation");
  const recs = buildRecommendations({ overview, openIncidents, freshness, slowQ });
  if (recs.length === 0) {
    lines.push("- System is healthy; no immediate follow-up required.");
  } else {
    for (const r of recs) lines.push(`- ${r}`);
  }
  lines.push("");

  return lines.join("\n");
}

function buildRecommendations(args: {
  overview: any;
  openIncidents: any[];
  freshness: { table: string; status: string; notes?: string }[];
  slowQ: any;
}): string[] {
  const recs: string[] = [];
  const o = args.overview;
  if (o && o.windows.h24.errorPct > 5) {
    recs.push(`24h error rate is ${o.windows.h24.errorPct.toFixed(1)}% — above the 5% guard. Open the active incidents and check the dominant fingerprint.`);
  }
  for (const f of args.freshness) {
    if (f.status === "missing" || f.status === "delayed") {
      recs.push(`Telemetry table \`${f.table}\` is ${f.status}${f.notes ? ` (${f.notes})` : ""}. Investigate the corresponding capture path.`);
    }
  }
  for (const inc of args.openIncidents.slice(0, 3)) {
    recs.push(`Triage incident \`${inc.fingerprint}\` (${inc.occurrenceCount} occurrences, peak ${inc.peakValue}).`);
  }
  if (args.slowQ?.available && args.slowQ.data.length > 0) {
    const top = args.slowQ.data[0];
    recs.push(`Top slow query consumed ${top.totalTimeMs}ms across ${top.calls} calls — mean ${top.meanTimeMs}ms. Inspect query plan.`);
  }
  return recs;
}
