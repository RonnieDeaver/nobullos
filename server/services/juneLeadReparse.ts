// @db-pool-intent: worker
//
// Every DB touch in this module goes through the injected `db` handle the
// prod-action drain passes in (getDb() under runWithWorkerDb → worker pool).
//
// Task #2753 — Re-parse ALL June 2026 reports' lead counts from their saved
// source PDFs, through the fixed Total-Leads reconciliation parser (see
// `reconcileTotalLeadsAgainstSources` in pdfImportParser.ts). Before that fix,
// a mis-read tiny "Total Leads" (e.g. 1) clamped every well-supported
// per-source lead count down to the bad total (Task #2555 guardrail firing in
// the wrong direction), so any June 2026 report imported through the old
// parser may carry crushed GBP / Google Ads / LSA / Webinar lead numbers.
//
// Driven by the `reparse_june_2026_report_leads` CEO prod-action as a
// convergent background drain: every June 2026 report is processed exactly
// once and stamped on its marketing section
// (`data.juneLeadReparseVersion` + `data.juneLeadReparseOutcome`), INCLUDING
// reports skipped for having no available source PDF — terminal items must
// stop counting or the action never converges (see memory
// "prod-action-convergence").
//
// Write policy: SURGICAL lead-field merge onto the EXISTING stored marketing
// section — never a full rebuild. Only lead counts, per-platform lead quality,
// recomputed cost-per-lead, and the lead-quality rollups are overwritten;
// operator-owned fields (review generation, blog URLs, heatmaps, dominance
// data, unresolved-import surfacing) are untouched. GBP locations are matched
// to EXISTING stored rows via the shared parenthetical matcher — parsed
// locations that don't resolve are ignored, never minted as new rows (see
// memory "gbp-report-location-ghosts"). Writes go through
// `storage.upsertReportSection` so the edit-audit trail
// (`report_section_history`) records the previous/new data exactly like any
// other section write.

import { and, eq, sql } from "drizzle-orm";
import { reports, reportSections } from "@shared/schema";
import { gbpNameMatches } from "@shared/gbpLocationMatch";
import {
  applyActiveProductsFilter,
  aggregateActiveLeadQuality,
} from "@shared/marketingWriteBoundary";
import type { CanonicalProduct } from "@shared/productResolution";

export const JUNE_LEAD_REPARSE_MONTH = "2026-06";
export const JUNE_LEAD_REPARSE_VERSION = 1;
export const JUNE_LEAD_REPARSE_STAMP_KEY = "juneLeadReparseVersion";
export const JUNE_LEAD_REPARSE_OUTCOME_KEY = "juneLeadReparseOutcome";

export type JuneReparseOutcome =
  | "corrected"
  | "unchanged"
  | "skipped_no_source"
  | "error";

export interface JuneReparseCandidate {
  reportId: string;
  clientId: string;
  sourcePdfStorageKey: string | null;
  webhookImportLogId: string | null;
  /** Marketing section id, or null when the report has no marketing row yet. */
  sectionId: string | null;
  marketingData: Record<string, any> | null;
}

/**
 * June 2026 reports whose marketing section is not yet stamped at the current
 * re-parse version. Reports WITHOUT a marketing section are still candidates
 * (they get a stamped empty section so the drain converges).
 */
export async function findJuneReparseCandidates(
  db: any,
): Promise<JuneReparseCandidate[]> {
  const rows = await db
    .select({
      reportId: reports.id,
      clientId: reports.clientId,
      sourcePdfStorageKey: reports.sourcePdfStorageKey,
      webhookImportLogId: reports.webhookImportLogId,
      sectionId: reportSections.id,
      marketingData: reportSections.data,
    })
    .from(reports)
    .leftJoin(
      reportSections,
      and(
        eq(reportSections.reportId, reports.id),
        eq(reportSections.sectionKey, "marketing"),
      ),
    )
    .where(
      and(
        eq(reports.reportMonth, JUNE_LEAD_REPARSE_MONTH),
        sql`(${reportSections.id} IS NULL OR COALESCE((${reportSections.data} ->> ${JUNE_LEAD_REPARSE_STAMP_KEY})::int, 0) < ${JUNE_LEAD_REPARSE_VERSION})`,
      ),
    );
  return rows.map((r: any) => ({
    reportId: r.reportId,
    clientId: r.clientId,
    sourcePdfStorageKey: r.sourcePdfStorageKey ?? null,
    webhookImportLogId: r.webhookImportLogId ?? null,
    sectionId: r.sectionId ?? null,
    marketingData: (r.marketingData ?? null) as Record<string, any> | null,
  }));
}

const ZERO_LQ = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

function cloneLq(lq: any): { good: number; notQuotable: number; missedCalls: number; noData: number } {
  return {
    good: lq?.good || 0,
    notQuotable: lq?.notQuotable || 0,
    missedCalls: lq?.missedCalls || 0,
    noData: lq?.noData || 0,
  };
}

/**
 * Pure lead-field merge: applies the freshly-parsed (already active-products-
 * filtered) marketing lead numbers onto a COPY of the existing stored
 * marketing data. Exported for tests.
 */
export function mergeReparsedLeadFields(
  existing: Record<string, any>,
  parsedMarketing: Record<string, any>,
  activeProducts: CanonicalProduct[],
): Record<string, any> {
  const next: Record<string, any> = JSON.parse(JSON.stringify(existing ?? {}));

  // GBP locations: update EXISTING rows only, matched via the shared
  // parenthetical-aware matcher. Unmatched parsed locations are ignored.
  const parsedLocs: any[] = Array.isArray(parsedMarketing?.gbpLocations)
    ? parsedMarketing.gbpLocations
    : [];
  const storedLocs: any[] = Array.isArray(next?.gbp?.locations)
    ? next.gbp.locations
    : [];
  for (const stored of storedLocs) {
    const match = parsedLocs.find((p) => gbpNameMatches(p?.name || "", stored?.name || ""));
    if (match) {
      stored.uniqueLeads = match.uniqueLeads || 0;
      stored.leadQuality = cloneLq(match.leadQuality);
    }
  }

  // Per-platform blocks — only when the (filtered) parse still carries them.
  if (parsedMarketing?.googleAds && next.googleAds) {
    const adSpend = parsedMarketing.googleAds.adSpend || next.googleAds.adSpend || 0;
    const uniqueLeads = parsedMarketing.googleAds.uniqueLeads || 0;
    next.googleAds = {
      ...next.googleAds,
      uniqueLeads,
      adSpend,
      leadQuality: cloneLq(parsedMarketing.googleAds.leadQuality),
      costPerLead: adSpend > 0 && uniqueLeads > 0 ? Math.round(adSpend / uniqueLeads) : 0,
    };
  }
  if (parsedMarketing?.lsa && next.lsa) {
    const adSpend = parsedMarketing.lsa.adSpend || next.lsa.adSpend || 0;
    const uniqueLeads = parsedMarketing.lsa.uniqueLeads || 0;
    next.lsa = {
      ...next.lsa,
      uniqueLeads,
      adSpend,
      leadQuality: cloneLq(parsedMarketing.lsa.leadQuality),
      costPerLead: adSpend > 0 && uniqueLeads > 0 ? Math.round(adSpend / uniqueLeads) : 0,
    };
  }
  if (parsedMarketing?.webinar && next.webinar) {
    next.webinar = {
      ...next.webinar,
      hotTransfers:
        parsedMarketing.webinar.hotTransfers || parsedMarketing.webinar.leads || 0,
      leadQuality: cloneLq(parsedMarketing.webinar.leadQuality),
    };
  }
  if (parsedMarketing?.otherLeads && next.otherLeads) {
    next.otherLeads = {
      ...next.otherLeads,
      count: parsedMarketing.otherLeads.total || 0,
      leadQuality: cloneLq(parsedMarketing.otherLeads.leadQuality),
    };
  }

  // Rollups: GBP-specific quality from the UPDATED stored locations; the
  // legacy all-platform rollup through the shared active-products aggregator
  // (same helper the webhook import uses).
  const gbpLeadQuality = { ...ZERO_LQ };
  for (const loc of storedLocs) {
    gbpLeadQuality.good += loc?.leadQuality?.good || 0;
    gbpLeadQuality.notQuotable += loc?.leadQuality?.notQuotable || 0;
    gbpLeadQuality.missedCalls += loc?.leadQuality?.missedCalls || 0;
    gbpLeadQuality.noData += loc?.leadQuality?.noData || 0;
  }
  next.gbpLeadQuality = gbpLeadQuality;
  next.leadQuality = aggregateActiveLeadQuality(next, activeProducts);

  if (typeof parsedMarketing?.totalLeads === "number") {
    next.totalLeads = parsedMarketing.totalLeads || 0;
  }

  return next;
}

export interface JuneReparseDeps {
  db: any;
  /** Load the saved private-object-storage copy. */
  loadSavedPdf: (objectKey: string) => Promise<Buffer | null>;
  /** Fetch the original live source URL (webhook_import_logs.pdf_source_url). */
  fetchUrlPdf: (url: string) => Promise<Buffer | null>;
  /** Look up the import log's pdfSourceUrl for the fallback fetch. */
  getImportLogSourceUrl: (importLogId: string) => Promise<string | null>;
  parsePdf: (buffer: Buffer) => Promise<any>;
  getActiveProducts: (clientId: string) => Promise<CanonicalProduct[]>;
  writeSection: (
    data: { reportId: string; sectionKey: string; data: any },
    attribution: { editor: string; source: string },
  ) => Promise<any>;
  actorId?: string | null;
}

export interface JuneReparseResult {
  outcome: JuneReparseOutcome;
  detail?: string;
}

function withStamp(
  data: Record<string, any>,
  outcome: JuneReparseOutcome,
): Record<string, any> {
  return {
    ...data,
    [JUNE_LEAD_REPARSE_STAMP_KEY]: JUNE_LEAD_REPARSE_VERSION,
    [JUNE_LEAD_REPARSE_OUTCOME_KEY]: outcome,
  };
}

/**
 * Key-order-insensitive serialization for the changed/unchanged check:
 * Postgres jsonb does NOT preserve object key order, and the merge rebuilds
 * lead-quality objects in source order, so a plain JSON.stringify comparison
 * would mark truly-identical data "corrected".
 */
export function stableStringify(value: any): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stripStamp(data: Record<string, any> | null): Record<string, any> {
  const { [JUNE_LEAD_REPARSE_STAMP_KEY]: _v, [JUNE_LEAD_REPARSE_OUTCOME_KEY]: _o, ...rest } =
    data ?? {};
  return rest;
}

/**
 * Process one June 2026 report: load its saved source PDF (fallback: the
 * original webhook source URL), re-parse through the fixed parser, apply the
 * active-products filter, surgically merge lead fields, and write ONLY when
 * the merged data differs. EVERY outcome stamps the marketing section so the
 * drain converges — including skips and errors.
 */
export async function processJuneReparseReport(
  deps: JuneReparseDeps,
  cand: JuneReparseCandidate,
): Promise<JuneReparseResult> {
  const attribution = {
    editor: deps.actorId || "system:june-lead-reparse",
    source: "system" as const,
  };
  const existing = stripStamp(cand.marketingData);

  const stampOnly = async (
    outcome: JuneReparseOutcome,
    detail?: string,
  ): Promise<JuneReparseResult> => {
    await deps.writeSection(
      {
        reportId: cand.reportId,
        sectionKey: "marketing",
        data: withStamp(existing, outcome),
      },
      attribution,
    );
    return { outcome, detail };
  };

  try {
    // 1) Source PDF: saved copy first, then the original live URL.
    let buffer: Buffer | null = null;
    if (cand.sourcePdfStorageKey) {
      buffer = await deps.loadSavedPdf(cand.sourcePdfStorageKey);
    }
    if (!buffer && cand.webhookImportLogId) {
      const url = await deps.getImportLogSourceUrl(cand.webhookImportLogId);
      if (url) {
        buffer = await deps.fetchUrlPdf(url).catch(() => null);
      }
    }
    if (!buffer) {
      return stampOnly(
        "skipped_no_source",
        "No saved source PDF and no fetchable original source URL",
      );
    }

    // 2) Re-parse through the fixed parser + active-products filter (same
    //    gate every import path applies).
    const parsed = await deps.parsePdf(buffer);
    const activeProducts = await deps.getActiveProducts(cand.clientId);
    applyActiveProductsFilter(parsed?.marketing ?? {}, activeProducts, {
      source: "june_lead_reparse",
      clientId: cand.clientId,
      reportId: cand.reportId,
    } as any);

    // 3) Surgical lead-field merge; compare against the existing data
    //    (stamp keys excluded) so an already-correct report is "unchanged".
    const merged = mergeReparsedLeadFields(
      existing,
      parsed?.marketing ?? {},
      activeProducts,
    );
    const changed = stableStringify(merged) !== stableStringify(existing);
    await deps.writeSection(
      {
        reportId: cand.reportId,
        sectionKey: "marketing",
        data: withStamp(merged, changed ? "corrected" : "unchanged"),
      },
      attribution,
    );
    return { outcome: changed ? "corrected" : "unchanged" };
  } catch (err: any) {
    // Terminal per-report failure: stamp with outcome "error" so the drain
    // converges; the outcome is queryable for a targeted follow-up.
    console.error(
      `[JuneLeadReparse] Report ${cand.reportId} failed: ${err?.message || err}`,
    );
    return stampOnly("error", err?.message || String(err));
  }
}

/**
 * Fetch a PDF from a (possibly redirecting, possibly expired) source URL.
 * Returns null on any failure — the caller treats that as "no source".
 */
export async function fetchSourceUrlPdf(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Basic sanity: PDFs start with %PDF
    if (buf.length < 5 || buf.subarray(0, 4).toString("latin1") !== "%PDF") {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

/** Production deps wiring (worker-pool db handle is passed by the drain). */
export async function buildProdJuneReparseDeps(
  db: any,
  actorId: string | null,
): Promise<JuneReparseDeps> {
  const { loadReportSourcePdf } = await import("./reportSourcePdf");
  const { parseReportPdf } = await import("./pdfImportParser");
  const { getActiveProductsForClient } = await import("./activeProducts");
  const { upsertReportSection } = await import("../storage/reportStorage");
  const { webhookImportLogs } = await import("@shared/schema");
  return {
    db,
    loadSavedPdf: loadReportSourcePdf,
    fetchUrlPdf: fetchSourceUrlPdf,
    getImportLogSourceUrl: async (importLogId: string) => {
      const [row] = await db
        .select({ url: webhookImportLogs.pdfSourceUrl })
        .from(webhookImportLogs)
        .where(eq(webhookImportLogs.id, importLogId));
      return row?.url ?? null;
    },
    parsePdf: parseReportPdf,
    getActiveProducts: async (clientId: string) =>
      (await getActiveProductsForClient(clientId)).products,
    writeSection: (data, attribution) =>
      upsertReportSection(data as any, attribution as any),
    actorId,
  };
}
