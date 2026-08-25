// @db-pool-intent: worker
//
// Task #2686 — Per-client Live Data BigQuery pull.
//
// Reuses the existing bigQueryClient.ts entry point (runAutoSourceQuery,
// BigQueryUnavailableError) and the performance-layer auto-source mappings
// (ris_auto_source_mappings + ris_client_auto_source_overrides) so the V1
// metric set and SQL templates stay consistent with RIS Performance — two
// surfaces, one source of truth.
//
// Degrade-gracefully posture (same as RIS):
//   • BigQuery not configured         → overall "not-configured", per-metric "not-configured"
//   • Client has no bigQueryClientKey → overall "not-configured"
//   • Mapping missing / disabled      → per-metric "not-configured"
//   • Query returns no row            → per-metric "no-data"
//   • Query throws                    → per-metric "error"
//
// BigQuery round-trips happen OUTSIDE any DB hold (per replit.md DB-hold rules).

import { getActiveClients, getClient } from "../../storage/clientStorage";
import {
  listRisChecks,
  listRisAutoSourceMappings,
  listRisClientAutoSourceOverrides,
} from "../../storage/risStorage";
import { insertLiveDataSnapshot } from "../../storage/liveDataStorage";
import {
  isBigQueryConfigured,
  runAutoSourceQuery,
  BigQueryUnavailableError,
} from "../ris/bigQueryClient";
import {
  resolveRisRule,
  indexOverridesByClientSource,
  templateNeedsClientKey,
} from "../ris/risRuleResolution";
import {
  type LiveDataMetric,
  type LiveDataOverallStatus,
} from "@shared/schema";

// ─── Period helpers ────────────────────────────────────────────────────

export function liveDataCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** The just-closed calendar month (Task #4766 close-out target). */
export function liveDataPreviousPeriod(): string {
  const now = new Date();
  const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const m = now.getMonth() === 0 ? 12 : now.getMonth();
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** N most recent COMPLETED months (newest first), excluding the current one. */
export function liveDataRecentCompletedPeriods(count: number): string[] {
  const out: string[] = [];
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth(); // 0-based → previous month when used 1-based
  for (let i = 0; i < count; i++) {
    if (m === 0) {
      y -= 1;
      m = 12;
    }
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
  }
  return out;
}

function periodRange(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map((n) => parseInt(n, 10));
  const start = `${period}-01`;
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  const end = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  return { start, end };
}

/** Unwrap the BigQuery library's Int/Numeric wrapper ({value: '12'} → 12). */
function extractNumericValue(
  row: Record<string, unknown>,
  column: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (!(column in row)) {
    return { ok: false, reason: `Result has no column "${column}"` };
  }
  let raw: unknown = row[column];
  if (raw !== null && typeof raw === "object" && "value" in raw) {
    raw = (raw as Record<string, unknown>).value;
  }
  if (raw === null || raw === undefined) {
    return { ok: false, reason: `Column "${column}" was empty` };
  }
  const num = Number(raw);
  if (Number.isNaN(num)) {
    return { ok: false, reason: `Column "${column}" was not numeric` };
  }
  return { ok: true, value: num };
}

// ─── Options / summary ────────────────────────────────────────────────

export interface LiveDataPullOptions {
  /** Limit the pull to one client; omit to sweep all active clients. */
  clientId?: string;
  /** Task #4766 — limit the pull to an explicit client-id set (close-out /
   *  seed callers). Ignored when `clientId` is set. */
  clientIds?: string[];
  /** Calendar month YYYY-MM; defaults to the current month. */
  period?: string;
}

export interface LiveDataPullSummary {
  period: string;
  clientsProcessed: number;
  snapshotsWritten: number;
  bigQueryConfigured: boolean;
  /** Task #4766 — per-client disposition (overall snapshot status written). */
  clientOutcomes: Array<{ clientId: string; overallStatus: LiveDataOverallStatus }>;
}

// ─── Main entry point ─────────────────────────────────────────────────

/**
 * Pull the V1 metric set from BigQuery for each active client (or a single
 * client when `options.clientId` is set) and persist a snapshot row.
 *
 * MUST be called outside a DB hold — BigQuery is a remote HTTP round-trip.
 */
export async function runLiveDataPull(
  options: LiveDataPullOptions = {},
): Promise<LiveDataPullSummary> {
  const period = options.period ?? liveDataCurrentPeriod();
  const { start: periodStart, end: periodEnd } = periodRange(period);

  const configured = isBigQueryConfigured();

  // Determine client list (reads the DB — no hold held across BQ calls).
  let clients: { id: string; bigQueryClientKey?: string | null }[];
  if (options.clientId) {
    const c = await getClient(options.clientId);
    clients = c ? [c] : [];
  } else if (options.clientIds) {
    const fetched = await Promise.all(options.clientIds.map((id) => getClient(id)));
    clients = fetched.filter((c): c is NonNullable<typeof c> => !!c);
  } else {
    clients = await getActiveClients();
  }

  const clientOutcomes: LiveDataPullSummary["clientOutcomes"] = [];

  if (clients.length === 0) {
    return {
      period,
      clientsProcessed: 0,
      snapshotsWritten: 0,
      bigQueryConfigured: configured,
      clientOutcomes,
    };
  }

  // Load catalog once — performance-layer checks with an autoSource tag.
  const [allChecks, mappings, allOverrides] = await Promise.all([
    listRisChecks({ activeOnly: true, layer: "performance" }),
    listRisAutoSourceMappings(),
    listRisClientAutoSourceOverrides(),
  ]);

  const mappingBySource = new Map(mappings.map((m) => [m.autoSource, m]));
  const overrideIndex = indexOverridesByClientSource(allOverrides);

  // Filter to checks that have an autoSource (the ones with BQ SQL templates).
  const checksWithSource = allChecks.filter((c) => c.autoSource);

  let snapshotsWritten = 0;

  for (const client of clients) {
    // Short-circuit: if BQ not configured at all, write per-metric not-configured entries
    // so the UI can show an explainable state for each metric rather than a blank list.
    if (!configured) {
      const metrics: LiveDataMetric[] = checksWithSource.map((c) => ({
        key: c.autoSource!,
        label: c.label,
        value: null,
        unitLabel: null,
        status: "not-configured" as const,
        reason: "BigQuery is not configured on this system",
      }));
      await insertLiveDataSnapshot({
        clientId: client.id,
        period,
        fetchedAt: new Date(),
        overallStatus: "not-configured",
        metrics,
      });
      snapshotsWritten++;
      clientOutcomes.push({ clientId: client.id, overallStatus: "not-configured" });
      continue;
    }

    // Short-circuit: client has no BQ key.
    if (!client.bigQueryClientKey) {
      const metrics: LiveDataMetric[] = checksWithSource.map((c) => ({
        key: c.autoSource!,
        label: c.label,
        value: null,
        unitLabel: null,
        status: "not-configured",
        reason: "Client has no BigQuery data key configured",
      }));
      await insertLiveDataSnapshot({
        clientId: client.id,
        period,
        fetchedAt: new Date(),
        overallStatus: "not-configured",
        metrics,
      });
      snapshotsWritten++;
      clientOutcomes.push({ clientId: client.id, overallStatus: "not-configured" });
      continue;
    }

    // Pull each metric — BigQuery calls happen OUTSIDE any DB hold.
    const fetchedAt = new Date();
    const metrics: LiveDataMetric[] = [];

    for (const check of checksWithSource) {
      const autoSource = check.autoSource!;
      const mapping = mappingBySource.get(autoSource);
      const override = overrideIndex.get(`${client.id}:${autoSource}`);
      const rule = resolveRisRule(mapping, override);

      // Mapping missing or disabled.
      if (!rule || !rule.enabled || !rule.sqlTemplate) {
        metrics.push({
          key: autoSource,
          label: check.label,
          value: null,
          unitLabel: mapping?.unitLabel ?? null,
          status: "not-configured",
          reason: !rule
            ? "No BigQuery mapping configured for this metric"
            : !rule.enabled
            ? "BigQuery mapping is disabled"
            : "No SQL template configured",
        });
        continue;
      }

      // Template requires @clientKey — already checked client.bigQueryClientKey exists above.
      if (templateNeedsClientKey(rule.sqlTemplate) && !client.bigQueryClientKey) {
        metrics.push({
          key: autoSource,
          label: check.label,
          value: null,
          unitLabel: rule.unitLabel,
          status: "not-configured",
          reason: "Client has no BigQuery data key configured",
        });
        continue;
      }

      // Execute the query — remote HTTP, must be outside DB hold.
      try {
        const result = await runAutoSourceQuery(rule, {
          clientId: client.id,
          locationId: null,
          periodStart,
          periodEnd,
          clientKey: client.bigQueryClientKey ?? null,
          filterValue: rule.filterValue ?? null,
        });

        if (!result.row) {
          metrics.push({
            key: autoSource,
            label: check.label,
            value: null,
            unitLabel: rule.unitLabel,
            status: "no-data",
            reason: "Query returned no rows for this period",
          });
          continue;
        }

        const extracted = extractNumericValue(result.row, rule.valueColumn);
        if (!extracted.ok) {
          metrics.push({
            key: autoSource,
            label: check.label,
            value: null,
            unitLabel: rule.unitLabel,
            status: "no-data",
            reason: extracted.reason,
          });
          continue;
        }

        metrics.push({
          key: autoSource,
          label: check.label,
          value: extracted.value,
          unitLabel: rule.unitLabel,
          status: "ok",
          reason: null,
        });
      } catch (err: any) {
        if (err instanceof BigQueryUnavailableError) {
          metrics.push({
            key: autoSource,
            label: check.label,
            value: null,
            unitLabel: rule.unitLabel,
            status: "not-configured",
            reason: err.message,
          });
        } else {
          metrics.push({
            key: autoSource,
            label: check.label,
            value: null,
            unitLabel: rule.unitLabel,
            status: "error",
            reason: err?.message ?? "Unknown BigQuery error",
          });
        }
      }
    }

    // Derive overall status.
    const overallStatus = deriveOverallStatus(metrics);

    await insertLiveDataSnapshot({
      clientId: client.id,
      period,
      fetchedAt,
      overallStatus,
      metrics,
    });
    snapshotsWritten++;
    clientOutcomes.push({ clientId: client.id, overallStatus });
  }

  return {
    period,
    clientsProcessed: clients.length,
    snapshotsWritten,
    bigQueryConfigured: configured,
    clientOutcomes,
  };
}

function deriveOverallStatus(metrics: LiveDataMetric[]): LiveDataOverallStatus {
  if (metrics.length === 0) return "not-configured";
  const statuses = metrics.map((m) => m.status);
  if (statuses.every((s) => s === "not-configured")) return "not-configured";
  if (statuses.every((s) => s === "ok")) return "ok";
  if (statuses.every((s) => s !== "ok")) {
    // Distinguish "all data absent" (no-data / not-configured) from a genuine pull error.
    const hasError = statuses.some((s) => s === "error");
    return hasError ? "error" : "partial";
  }
  return "partial";
}
