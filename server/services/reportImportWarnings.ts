// @db-pool-intent: ambient
/**
 * Task #3769 — broken-source import warnings for report PDF imports.
 *
 * Background:
 *   The July 2026 Ackah Law PDF was generated while its consult/case
 *   component had a broken upstream data source, so the import stored
 *   totalConsults: 0 / totalCases: 0 ("not entered" per design) and the raw
 *   "Missing data source … Name_Clean (1): Ackah Law" placeholder. Nothing
 *   warned anyone: the report was finalized and shared with empty funnel
 *   metrics. This module computes a per-section warning when an import lands
 *   with Consults/Cases missing that the client's MOST RECENT PRIOR report
 *   had entered — or when the section's raw Common Issues text matched the
 *   missing-data-source placeholder — so all three import paths (webhook,
 *   manual upload, reimport) can persist it with the report (mirroring the
 *   `gbpUnresolvedImports` pattern), the Report Form can show a banner
 *   naming the affected metrics, and the report owner gets a dedupe-keyed
 *   inbox notification.
 *
 * Lifecycle of the persisted key (`brokenSourceImportWarning` on the intake
 * and sales section data):
 *   - Written by the import paths when the warning condition holds.
 *   - A webhook re-import recomputes it (wholesale section replace).
 *   - A normal operator save omits the key, clearing it — same lifecycle as
 *     `gbpUnresolvedImports` (the operator addressed / acknowledged it).
 *   - Serve-time: buildReportResponse strips it from shared/preview payloads
 *     (internal operator signal, never client-visible).
 */

import { isMetricEntered } from "@shared/reportMetrics";
import { storage } from "../storage";
// F5 — typed JSONB accessors for the intake/sales section reads (prior-report
// funnel entries + still-missing recheck) instead of bare Record casts.
import {
  readOptionalIntakeSection,
  readOptionalSalesSection,
} from "../lib/reportJsonbAccessors";

/** Key persisted on intake/sales section data. */
export const BROKEN_SOURCE_WARNING_KEY = "brokenSourceImportWarning";

/**
 * Inbox dedupe-key prefix. Full key is `${prefix}:${reportId}` — one open
 * notification per report regardless of how many sections/paths flag it.
 * Tests must scope notification assertions by this prefix (never total
 * counts) so unrelated suites stay green.
 */
export const BROKEN_SOURCE_NOTIFY_DEDUPE_PREFIX = "report-import-broken-source";

export type FunnelMetricKey = "totalConsults" | "totalCases";
export type BrokenSourceImportSource = "webhook" | "reimport" | "manual_pdf_upload";

export interface BrokenSourceSectionWarning {
  /** Which of this section's key funnel metrics are missing-vs-prior. */
  missingMetrics: FunnelMetricKey[];
  /** This section's raw Common Issues matched the missing-data-source placeholder. */
  rawPlaceholder: boolean;
  /** Month (YYYY-MM) of the prior report used for the missing-vs-prior check. */
  priorReportMonth: string | null;
  source: BrokenSourceImportSource;
  detectedAt: string;
}

export interface PriorFunnelEntries {
  priorReportMonth: string | null;
  consultsEntered: boolean;
  casesEntered: boolean;
}

/**
 * Load whether the client's most recent report BEFORE `currentReportMonth`
 * has Consults (intake) / Cases (sales) entered, per the shared
 * `isMetricEntered` semantics (positive number, not no-data-flagged).
 * Returns all-false when there is no prior report — a first report can
 * never be "missing vs prior".
 */
export async function loadPriorFunnelEntries(
  clientId: string,
  currentReportMonth: string,
  excludeReportId?: string,
): Promise<PriorFunnelEntries> {
  const none: PriorFunnelEntries = {
    priorReportMonth: null,
    consultsEntered: false,
    casesEntered: false,
  };
  if (!clientId || !currentReportMonth) return none;

  const all = await storage.getReportsByClient(clientId);
  const prior = all
    .filter(
      (r) =>
        typeof r.reportMonth === "string" &&
        r.reportMonth < currentReportMonth &&
        r.id !== excludeReportId,
    )
    .sort((a, b) => b.reportMonth.localeCompare(a.reportMonth))[0];
  if (!prior) return none;

  const sections = await storage.getReportSections(prior.id);
  const intakeRow = sections.find((s) => s.sectionKey === "intake");
  const salesRow = sections.find((s) => s.sectionKey === "sales");
  const intake = readOptionalIntakeSection(intakeRow?.data, {
    sectionId: intakeRow?.id,
    reportId: prior.id,
    clientId,
  });
  const sales = readOptionalSalesSection(salesRow?.data, {
    sectionId: salesRow?.id,
    reportId: prior.id,
    clientId,
  });

  return {
    priorReportMonth: prior.reportMonth,
    consultsEntered: isMetricEntered(
      intake?.totalConsults,
      intake?.noDataFlags?.totalConsults === true,
    ),
    casesEntered: isMetricEntered(
      sales?.totalCases,
      sales?.noDataFlags?.totalCases === true,
    ),
  };
}

/**
 * Pure per-section warning computation. `effectiveValue` is the funnel value
 * about to be stored for this section (intake → totalConsults,
 * sales → totalCases) AFTER any merge with existing data. Returns null when
 * there is nothing to warn about (the section stores no key).
 */
export function computeBrokenSourceSectionWarning(opts: {
  sectionKey: "intake" | "sales";
  effectiveValue: unknown;
  noDataFlagged?: boolean;
  rawPlaceholder: boolean;
  prior: PriorFunnelEntries;
  source: BrokenSourceImportSource;
  now?: Date;
}): BrokenSourceSectionWarning | null {
  const metric: FunnelMetricKey =
    opts.sectionKey === "intake" ? "totalConsults" : "totalCases";
  const priorEntered =
    opts.sectionKey === "intake"
      ? opts.prior.consultsEntered
      : opts.prior.casesEntered;
  const missingVsPrior =
    priorEntered && !isMetricEntered(opts.effectiveValue, opts.noDataFlagged);
  const missingMetrics: FunnelMetricKey[] = missingVsPrior ? [metric] : [];

  if (missingMetrics.length === 0 && !opts.rawPlaceholder) return null;

  return {
    missingMetrics,
    rawPlaceholder: opts.rawPlaceholder,
    priorReportMonth: opts.prior.priorReportMonth,
    source: opts.source,
    detectedAt: (opts.now ?? new Date()).toISOString(),
  };
}

/**
 * True when the parser's field-confidence map says this section's raw
 * Common Issues body matched the missing-data-source placeholder (the parsed
 * value itself is "" in that case, so the confidence source string is the
 * only surviving signal at the route layer).
 */
export function rawCommonIssuesMatchedPlaceholder(
  fieldConfidence: Record<string, { confidence: string; source: string }> | undefined,
  sectionKey: "intake" | "sales",
): boolean {
  const fc = fieldConfidence?.[`${sectionKey}.commonIssues`];
  return !!fc && typeof fc.source === "string" && /missing data source/i.test(fc.source);
}

export function funnelMetricLabel(metric: FunnelMetricKey): string {
  return metric === "totalConsults" ? "Consults" : "Cases";
}

/**
 * Task #3769 — server-side finalize gate input. Given a report's CURRENT
 * sections, return the funnel metrics that (a) a persisted broken-source
 * import warning flagged as missing-vs-prior AND (b) are STILL not entered
 * (and not deliberately No-Data-flagged) right now. Finalizing while this is
 * non-empty requires the explicit `confirmBrokenSourceFinalize` request
 * field — the Report Form dialog is UI sugar, this is the enforcement.
 *
 * A stale warning whose metric has since been entered (a positive value with
 * its No-Data flag clear — a still-flagged metric counts as not entered, per
 * `isMetricEntered`), or a warning cleared by a normal operator save,
 * contributes nothing.
 * `rawPlaceholder`-only warnings never block — only the key funnel metrics.
 */
export function computeStillMissingBrokenSourceMetrics(
  sections: Array<{ sectionKey: string; data: unknown; id?: string; reportId?: string }>,
): FunnelMetricKey[] {
  const stillMissing: FunnelMetricKey[] = [];
  const check = (sectionKey: "intake" | "sales", metric: FunnelMetricKey) => {
    const row = sections.find((s) => s.sectionKey === sectionKey);
    const raw = row?.data;
    const ctx = { sectionId: row?.id, reportId: row?.reportId };
    const data =
      sectionKey === "intake"
        ? readOptionalIntakeSection(raw, ctx)
        : readOptionalSalesSection(raw, ctx);
    const warning = data?.[BROKEN_SOURCE_WARNING_KEY];
    if (!warning || !Array.isArray(warning.missingMetrics)) return;
    if (!warning.missingMetrics.includes(metric)) return;
    if (!isMetricEntered(data?.[metric], data?.noDataFlags?.[metric] === true)) {
      stillMissing.push(metric);
    }
  };
  check("intake", "totalConsults");
  check("sales", "totalCases");
  return stillMissing;
}

/**
 * Task #3813 — an import must never stamp a No-Data flag on a funnel metric
 * it is simultaneously warning about. The warning means "value missing,
 * awaiting operator entry"; a No-Data flag reads as a deliberate decision.
 * When Task #3772's absent-stays-absent stamping also flagged the warned
 * metrics, the finalize gate above treated them as permanently not-entered —
 * entering the real values could no longer clear the block. Warned funnel
 * metrics therefore keep `false` (entry-tracked, not flagged): unentered
 * funnel metrics render "No Data" either way, and the gate clears the
 * moment the operator enters the real values.
 */
export function unflagWarnedFunnelMetrics(
  flags: Record<string, boolean>,
  warning: BrokenSourceSectionWarning | null,
): Record<string, boolean> {
  if (!warning || warning.missingMetrics.length === 0) return flags;
  const out = { ...flags };
  for (const metric of warning.missingMetrics) out[metric] = false;
  return out;
}
/**
 * Build the owner inbox notification for a report whose import tripped one
 * or both section warnings. Callers wrap notifyUser in best-effort
 * try/catch — a notification failure never fails an import.
 */
export function buildBrokenSourceNotification(opts: {
  reportId: string;
  clientId: string;
  firmName: string;
  reportMonth: string;
  intakeWarning: BrokenSourceSectionWarning | null;
  salesWarning: BrokenSourceSectionWarning | null;
}): {
  category: "system";
  title: string;
  body: string;
  deepLink: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
} | null {
  const missingMetrics: FunnelMetricKey[] = [
    ...(opts.intakeWarning?.missingMetrics ?? []),
    ...(opts.salesWarning?.missingMetrics ?? []),
  ];
  const placeholderSections = [
    ...(opts.intakeWarning?.rawPlaceholder ? ["intake"] : []),
    ...(opts.salesWarning?.rawPlaceholder ? ["sales"] : []),
  ];
  if (missingMetrics.length === 0 && placeholderSections.length === 0) return null;

  const metricLabels = missingMetrics.map(funnelMetricLabel);
  const priorMonth =
    opts.intakeWarning?.priorReportMonth ?? opts.salesWarning?.priorReportMonth ?? null;

  const parts: string[] = [];
  if (metricLabels.length > 0) {
    parts.push(
      `${metricLabels.join(" and ")} came in empty even though the previous report${priorMonth ? ` (${priorMonth})` : ""} had ${metricLabels.length > 1 ? "them" : "it"} entered`,
    );
  }
  if (placeholderSections.length > 0) {
    parts.push(
      `the ${placeholderSections.join(" and ")} Common Issues text was the "Missing data source" placeholder`,
    );
  }

  return {
    category: "system",
    title: `Imported report may have a broken data source — ${metricLabels.length > 0 ? metricLabels.join("/") : "Common Issues"} affected`,
    body: `The ${opts.reportMonth} PDF import for ${opts.firmName} looks like it came from a report with a broken upstream data source: ${parts.join(", and ")}. The full numbers will show "No data" until entered. Enter the real values in the Report Form or re-import a corrected PDF before finalizing/sharing.`,
    deepLink: `/reports/${opts.reportId}`,
    dedupeKey: `${BROKEN_SOURCE_NOTIFY_DEDUPE_PREFIX}:${opts.reportId}`,
    metadata: {
      reportId: opts.reportId,
      clientId: opts.clientId,
      reportMonth: opts.reportMonth,
      missingMetrics,
      placeholderSections,
      priorReportMonth: priorMonth,
    },
  };
}
