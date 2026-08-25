// @db-pool-intent: worker
//
// Task #2371 — RIS Performance Layer pull.
//
// Sibling of the Task #2368 QA auto-pull (risAutoPull.ts), but instead of a
// single observed value scored Pass/Fail it computes a color-coded
// Green / Yellow / Red / Gray health status from a PERIOD-OVER-PERIOD
// comparison vs admin-tunable thresholds (risThresholds.ts).
//
// For volume / cost / rate metrics it runs the mapping's SQL twice — once
// for the current month, once for the prior month — and feeds both values
// to the threshold engine. For `budget` (pacing) it runs a single current
// query whose value IS the pacing percent (actual/expected × 100).
//
// Degrade-gracefully posture (same as #2368): a check whose mapping is
// missing / disabled / unconfigured, or whose query is unreachable / errors
// / returns no row, is parked at GRAY with a plain-English reason — NEVER a
// silent Green.
//
// DB-hold discipline (replit.md): the BigQuery round-trips happen OUTSIDE
// any DB hold. Catalog/mapping/scope reads and each result write are short,
// individually attributed holds; the network calls sit between them with no
// connection checked out.

import { normalizeProductList } from "@shared/productResolution";
import {
  getActiveClients,
  getClient,
} from "../../storage/clientStorage";
import {
  listRisChecks,
  listRisAutoSourceMappings,
  listRisClientAutoSourceOverrides,
  setRisAutoResult,
} from "../../storage/risStorage";
import {
  isBigQueryConfigured,
  runAutoSourceQuery,
  BigQueryUnavailableError,
} from "./bigQueryClient";
import {
  resolveRisRule,
  indexOverridesByClientSource,
  templateNeedsClientKey,
  type ResolvedRisRule,
} from "./risRuleResolution";
import { computePerformanceStatus } from "./risThresholds";
import { processRisResultFlag } from "./risFlagging";
import { currentPeriod } from "./risService";
import type {
  RisCheck,
  RisMetricType,
  RisThresholdOverride,
} from "@shared/schema";

export interface RisPerformancePullOptions {
  /** Limit the pull to a single client; omit to sweep all active clients. */
  clientId?: string;
  /** Calendar month `YYYY-MM`; defaults to the current month. */
  period?: string;
}

export interface RisPerformancePullSummary {
  period: string;
  priorPeriod: string;
  clientsProcessed: number;
  checksConsidered: number;
  written: number;
  gray: number;
  skipped: number;
  bigQueryConfigured: boolean;
}

/** First/last day boundaries (`YYYY-MM-DD`) for a `YYYY-MM` period. */
function periodRange(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map((n) => parseInt(n, 10));
  const start = `${period}-01`;
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  const end = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  return { start, end };
}

/** The calendar month immediately before a `YYYY-MM` period. */
function priorPeriodOf(period: string): string {
  const [y, m] = period.split("-").map((n) => parseInt(n, 10));
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

/** Pull a numeric value out of a BigQuery row, unwrapping the library's
 *  BigQueryInt/Numeric wrapper ({ value: '12' }). */
function extractValue(
  row: Record<string, unknown>,
  valueColumn: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (!(valueColumn in row)) {
    return { ok: false, reason: `Result has no column "${valueColumn}"` };
  }
  let raw: unknown = row[valueColumn];
  if (raw !== null && typeof raw === "object" && "value" in (raw as any)) {
    raw = (raw as any).value;
  }
  if (raw === null || raw === undefined) {
    return { ok: false, reason: `Column "${valueColumn}" was empty` };
  }
  const num = Number(raw);
  if (Number.isNaN(num)) {
    return { ok: false, reason: `Column "${valueColumn}" was not numeric` };
  }
  return { ok: true, value: num };
}

function formatValue(value: number | null, unitLabel: string | null): string | null {
  if (value == null) return null;
  return unitLabel ? `${value} ${unitLabel}` : String(value);
}

/** Parse the catalog row's JSONB threshold override into the engine's shape.
 *  Stored as `unknown` (jsonb); we only forward the recognized keys. */
function parseThresholds(raw: unknown): RisThresholdOverride | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as RisThresholdOverride;
}

interface PerfInstance {
  check: RisCheck;
  clientId: string;
}

/**
 * Run one mapping query for a single period and return the numeric value or
 * a gray reason. Pure pass-through of the degrade taxonomy.
 */
async function queryPeriodValue(
  rule: ResolvedRisRule,
  clientId: string,
  clientKey: string | null,
  period: string,
): Promise<{ ok: true; value: number } | { ok: false; reason: string }> {
  const { start, end } = periodRange(period);
  try {
    const { row } = await runAutoSourceQuery(rule, {
      clientId,
      locationId: null,
      periodStart: start,
      periodEnd: end,
      clientKey,
      filterValue: rule.filterValue,
    });
    if (!row) {
      return { ok: false, reason: "BigQuery returned no data for this period" };
    }
    return extractValue(row, rule.valueColumn);
  } catch (err: any) {
    return {
      ok: false,
      reason:
        err instanceof BigQueryUnavailableError
          ? `BigQuery unavailable: ${err.message}`
          : `BigQuery query failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * Run the Performance pull. Returns a summary. Safe to call from the
 * scheduler (worker pool) or the on-demand /api/ris/refresh route.
 */
export async function runRisPerformancePull(
  opts: RisPerformancePullOptions = {},
): Promise<RisPerformancePullSummary> {
  const period = opts.period ?? currentPeriod();
  const priorPeriod = priorPeriodOf(period);
  const bqConfigured = isBigQueryConfigured();

  // ── Read phase: performance catalog + mappings + client scope. ──
  const checks = (await listRisChecks({ activeOnly: true })).filter(
    (c) => c.layer === "performance" && c.autoSource && c.metricType,
  );
  const summary: RisPerformancePullSummary = {
    period,
    priorPeriod,
    clientsProcessed: 0,
    checksConsidered: 0,
    written: 0,
    gray: 0,
    skipped: 0,
    bigQueryConfigured: bqConfigured,
  };
  if (checks.length === 0) return summary;

  const mappings = await listRisAutoSourceMappings();
  const mappingBySource = new Map(mappings.map((m) => [m.autoSource, m]));

  // Task #2485 — per-client overrides + binding key, layered over globals.
  const overrides = await listRisClientAutoSourceOverrides(opts.clientId);
  const overrideByClientSource = indexOverridesByClientSource(overrides);

  const clients = opts.clientId
    ? [await getClient(opts.clientId)].filter(
        (c): c is NonNullable<typeof c> => !!c,
      )
    : await getActiveClients();

  // Performance checks are product-level (no location fan-out in V1).
  const firmNameById = new Map(clients.map((c) => [c.id, c.firmName]));
  const clientKeyById = new Map(
    clients.map((c) => [c.id, c.bigQueryClientKey ?? null]),
  );
  const instances: PerfInstance[] = [];
  for (const client of clients) {
    const products = normalizeProductList(client.products ?? []);
    for (const check of checks) {
      if (check.product !== "universal" && !products.includes(check.product as any)) {
        continue;
      }
      instances.push({ check, clientId: client.id });
    }
    summary.clientsProcessed++;
  }
  summary.checksConsidered = instances.length;

  // ── Evaluate each instance: BigQuery (no hold) → write (hold). ──
  for (const inst of instances) {
    const metricType = inst.check.metricType as RisMetricType;
    const bands = parseThresholds(inst.check.thresholds);
    const mapping = mappingBySource.get(inst.check.autoSource!);
    // Resolve the effective rule: per-client override over global mapping.
    const override = overrideByClientSource.get(
      `${inst.clientId}:${inst.check.autoSource}`,
    );
    const rule = resolveRisRule(mapping, override);
    const clientKey = clientKeyById.get(inst.clientId) ?? null;
    const enabled = rule?.enabled && rule.sqlTemplate.trim().length > 0;

    let status: string;
    let observedValue: string | null = null;
    let currentValue: string | null = null;
    let previousValue: string | null = null;
    let changePct: string | null = null;
    let autoError: string | null;

    if (!rule) {
      status = "gray";
      autoError = `No BigQuery mapping configured for "${inst.check.autoSource}"`;
    } else if (!enabled) {
      status = "gray";
      autoError = !rule.enabled
        ? "BigQuery mapping is disabled"
        : "BigQuery mapping has no query configured";
    } else if (templateNeedsClientKey(rule.sqlTemplate) && !clientKey) {
      // Resolved template needs the client key but this client has none —
      // degrade to gray rather than run with a NULL key (never silent Green).
      status = "gray";
      autoError =
        "Query needs a BigQuery client key but none is set for this client";
    } else if (metricType === "budget") {
      // Single current query whose value is the pacing percent.
      const cur = await queryPeriodValue(rule, inst.clientId, clientKey, period);
      if (!cur.ok) {
        status = "gray";
        autoError = cur.reason;
      } else {
        const verdict = computePerformanceStatus({
          metricType,
          current: cur.value,
          bands,
        });
        status = verdict.status;
        currentValue = String(cur.value);
        observedValue = formatValue(cur.value, rule.unitLabel ?? null);
        autoError = null;
      }
    } else {
      // Dual-period comparison: current + prior.
      const [cur, prev] = await Promise.all([
        queryPeriodValue(rule, inst.clientId, clientKey, period),
        queryPeriodValue(rule, inst.clientId, clientKey, priorPeriod),
      ]);
      if (!cur.ok) {
        status = "gray";
        autoError = cur.reason;
      } else {
        const prevValue = prev.ok ? prev.value : null;
        const verdict = computePerformanceStatus({
          metricType,
          current: cur.value,
          previous: prevValue,
          bands,
        });
        status = verdict.status;
        currentValue = String(cur.value);
        previousValue = prevValue == null ? null : String(prevValue);
        changePct = verdict.changePct == null ? null : String(verdict.changePct);
        observedValue = formatValue(cur.value, rule.unitLabel ?? null);
        autoError =
          status === "gray"
            ? prev.ok
              ? "Not enough prior-period volume to compare"
              : prev.reason
            : null;
      }
    }

    const outcome = await setRisAutoResult({
      checkId: inst.check.id,
      clientId: inst.clientId,
      locationId: null,
      period,
      status,
      observedValue,
      currentValue,
      previousValue,
      changePct,
      autoError,
    });
    if (outcome.kind === "skipped") summary.skipped++;
    else {
      summary.written++;
      if (status === "gray") summary.gray++;
      // Fire / resolve the escalation flag (best effort; never throws). A
      // Red at High/Critical severity escalates to the owning + reporting
      // functions; moving off Red resolves it. Outside any DB hold.
      await processRisResultFlag({
        check: inst.check,
        result: outcome.result,
        firmName: firmNameById.get(inst.clientId) ?? "Client",
        locationName: null,
        previousStatus: outcome.previousStatus,
      });
    }
  }

  return summary;
}
