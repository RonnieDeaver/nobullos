// @db-pool-intent: worker
//
// Task #2368 — RIS BigQuery auto-pull.
//
// Materializes the observed value + suggested status for every
// `auto_source`-tagged RIS check by querying BigQuery through a
// runtime-configurable mapping. The whole thing is built to degrade
// gracefully: a check whose mapping is disabled / unconfigured, or whose
// query is unreachable / errors / returns no row, is parked at
// `needs_review` with a plain-English reason — NEVER a silent Pass.
//
// DB-hold discipline (replit.md): the remote BigQuery round-trip happens
// OUTSIDE any DB hold. The read phase (catalog + mappings + client scope)
// and each result write are individually short, attributed holds; the
// network call sits between them with no connection checked out.

import { normalizeProductList } from "../../utils/productResolution";
import {
  getActiveClients,
  getClient,
  getClientLocations,
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
import { currentPeriod } from "./risService";
import type {
  RisAutoComparator,
  RisCheck,
} from "@shared/schema";

export interface RisAutoPullOptions {
  /** Limit the pull to a single client; omit to sweep all active clients. */
  clientId?: string;
  /** Calendar month `YYYY-MM`; defaults to the current month. */
  period?: string;
}

export interface RisAutoPullSummary {
  period: string;
  clientsProcessed: number;
  checksConsidered: number;
  written: number;
  needsReview: number;
  skipped: number;
  bigQueryConfigured: boolean;
}

/** First day of the month (inclusive) and first day of the next month
 *  (exclusive) for a `YYYY-MM` period, as `YYYY-MM-DD` strings. */
function periodRange(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map((n) => parseInt(n, 10));
  const start = `${period}-01`;
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  const end = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  return { start, end };
}

/** Pull the numeric value out of a BigQuery result row, unwrapping the
 *  library's BigQueryInt/Numeric wrapper objects ({ value: '12' }). */
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

function compare(
  value: number,
  comparator: RisAutoComparator,
  threshold: number,
): boolean {
  switch (comparator) {
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "lt": return value < threshold;
    case "eq": return value === threshold;
    case "ne": return value !== threshold;
    case "none": return false;
  }
}

function formatObserved(value: number, unitLabel: string | null): string {
  return unitLabel ? `${value} ${unitLabel}` : String(value);
}

/**
 * Decide the suggested status from an observed value + the mapping's
 * comparator/threshold. When the comparator is `none` or the threshold is
 * missing/non-numeric we record the value but leave the human to judge
 * (needs_review) rather than guessing a Pass/Fail.
 */
function suggestStatus(
  value: number,
  rule: ResolvedRisRule,
): { status: "pass" | "fail" | "needs_review"; autoError: string | null } {
  if (rule.comparator === "none") {
    return { status: "needs_review", autoError: "Observed value recorded; no pass/fail rule configured" };
  }
  const threshold = rule.threshold == null ? NaN : Number(rule.threshold);
  if (Number.isNaN(threshold)) {
    return { status: "needs_review", autoError: "Observed value recorded; threshold not configured" };
  }
  const pass = compare(value, rule.comparator as RisAutoComparator, threshold);
  return { status: pass ? "pass" : "fail", autoError: null };
}

interface AutoInstance {
  check: RisCheck;
  clientId: string;
  locationId: string | null;
}

/**
 * Run the auto-pull. Returns a summary of what happened. Safe to call from
 * the scheduler (worker pool) or the on-demand route.
 */
export async function runRisAutoPull(
  opts: RisAutoPullOptions = {},
): Promise<RisAutoPullSummary> {
  const period = opts.period ?? currentPeriod();
  const { start, end } = periodRange(period);
  const bqConfigured = isBigQueryConfigured();

  // ── Read phase: catalog + mappings + client scope (short holds). ──
  // QA layer only. Performance-layer checks also carry an autoSource but are
  // scored by a period-over-period comparator in runRisPerformancePull, so
  // they must NOT be processed here with the QA pass/fail comparator.
  const checks = (await listRisChecks({ activeOnly: true })).filter(
    (c) => c.autoSource && c.frequency !== "launch_only" && c.layer !== "performance",
  );
  const summary: RisAutoPullSummary = {
    period,
    clientsProcessed: 0,
    checksConsidered: 0,
    written: 0,
    needsReview: 0,
    skipped: 0,
    bigQueryConfigured: bqConfigured,
  };
  if (checks.length === 0) return summary;

  const mappings = await listRisAutoSourceMappings();
  const mappingBySource = new Map(mappings.map((m) => [m.autoSource, m]));

  // Task #2485 — per-client overrides + binding key. Override resolution and
  // the client key both layer over the global mapping below.
  const overrides = await listRisClientAutoSourceOverrides(opts.clientId);
  const overrideByClientSource = indexOverridesByClientSource(overrides);

  const clients = opts.clientId
    ? [await getClient(opts.clientId)].filter(
        (c): c is NonNullable<typeof c> => !!c,
      )
    : await getActiveClients();
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // Expand to the per-client / per-location instances we must evaluate.
  const instances: AutoInstance[] = [];
  for (const client of clients) {
    const products = normalizeProductList(client.products ?? []);
    let locations: { id: string }[] = [];
    const needsLocations = checks.some(
      (c) =>
        c.locationSpecific &&
        (c.product === "universal" || products.includes(c.product as any)),
    );
    if (needsLocations) {
      const raw = await getClientLocations(client.id).catch(() => []);
      locations = raw.filter((l) => l.isActive !== false).map((l) => ({ id: l.id }));
    }
    for (const check of checks) {
      if (check.product !== "universal" && !products.includes(check.product as any)) {
        continue;
      }
      if (check.locationSpecific && locations.length > 0) {
        for (const loc of locations) {
          instances.push({ check, clientId: client.id, locationId: loc.id });
        }
      } else {
        instances.push({ check, clientId: client.id, locationId: null });
      }
    }
    summary.clientsProcessed++;
  }
  summary.checksConsidered = instances.length;

  // ── Evaluate each instance: BigQuery call (no hold) → write (hold). ──
  for (const inst of instances) {
    const mapping = mappingBySource.get(inst.check.autoSource!);
    // Resolve the effective rule: per-client override layered over the global
    // mapping (Task #2485). null when there is no global mapping at all.
    const override = overrideByClientSource.get(
      `${inst.clientId}:${inst.check.autoSource}`,
    );
    const rule = resolveRisRule(mapping, override);
    const clientKey = clientById.get(inst.clientId)?.bigQueryClientKey ?? null;
    const enabled = rule?.enabled && rule.sqlTemplate.trim().length > 0;

    let status: string;
    let observedValue: string | null;
    let autoError: string | null;

    if (!rule) {
      status = "needs_review";
      observedValue = null;
      autoError = `No BigQuery mapping configured for "${inst.check.autoSource}"`;
    } else if (!enabled) {
      status = "needs_review";
      observedValue = null;
      autoError = !rule.enabled
        ? "BigQuery mapping is disabled"
        : "BigQuery mapping has no query configured";
    } else if (templateNeedsClientKey(rule.sqlTemplate) && !clientKey) {
      // The resolved template needs the client key but this client has none —
      // degrade rather than run with a NULL key (never a silent Pass).
      status = "needs_review";
      observedValue = null;
      autoError =
        "Query needs a BigQuery client key but none is set for this client";
    } else {
      // Remote round-trip — explicitly OUTSIDE any DB hold.
      try {
        const { row } = await runAutoSourceQuery(rule, {
          clientId: inst.clientId,
          locationId: inst.locationId,
          periodStart: start,
          periodEnd: end,
          clientKey,
          filterValue: rule.filterValue,
        });
        if (!row) {
          status = "needs_review";
          observedValue = null;
          autoError = "BigQuery returned no data for this period";
        } else {
          const v = extractValue(row, rule.valueColumn);
          if (!v.ok) {
            status = "needs_review";
            observedValue = null;
            autoError = v.reason;
          } else {
            const suggestion = suggestStatus(v.value, rule);
            status = suggestion.status;
            observedValue = formatObserved(v.value, rule.unitLabel);
            autoError = suggestion.autoError;
          }
        }
      } catch (err: any) {
        status = "needs_review";
        observedValue = null;
        autoError =
          err instanceof BigQueryUnavailableError
            ? `BigQuery unavailable: ${err.message}`
            : `BigQuery query failed: ${err?.message ?? err}`;
      }
    }

    const outcome = await setRisAutoResult({
      checkId: inst.check.id,
      clientId: inst.clientId,
      locationId: inst.locationId,
      period,
      status,
      observedValue,
      autoError,
    });
    if (outcome.kind === "skipped") summary.skipped++;
    else {
      summary.written++;
      if (status === "needs_review") summary.needsReview++;
    }
  }

  return summary;
}
