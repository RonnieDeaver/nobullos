// @db-pool-intent: worker
//
// Task #4175 — report data historical hygiene (F3 closure).
//
// The F3 script-disposition sweep (audits/f3-operational-script-disposition-
// 2026-08-09.md §3/§4/§6) measured three never-applied-in-prod gaps left by
// dev-era one-off scripts:
//
//   1. 143 pre-2026-05-13 reports missing one or more of the four canonical
//      section rows (intake/sales/marketing/nextActions) — blank tabs until
//      someone saves them (was scripts/backfill-empty-report-sections.ts).
//   2. 311 pre-Task-#829 report sections with zero report_section_history
//      rows — empty "edit history" dialog (was
//      scripts/backfill-report-section-history.ts).
//   3. ~150+ marketing sections still carrying platform blocks for products
//      the client doesn't own (Task #1028 residue; hidden on the public
//      report by the read sanitizer, visible in internal views — was
//      scripts/reports-cleanup-inactive-products.ts).
//
// This module is the audited replacement for all three scripts (the scripts
// themselves are deleted; git history is the archive). Each helper takes the
// Drizzle handle from the caller — the prod actions in
// `prodActionsRegistry.ts` pass `getDb()` under `withDbAttribution`, and the
// F3 caveat is handled here: the inactive-product cleanup routes every write
// through `upsertReportSection` so `report_section_history` is preserved
// (the old script's direct UPDATE bypassed it).

import { and, eq, sql } from "drizzle-orm";

import {
  reports,
  reportSections,
  reportSectionHistory,
  clients as clientsTable,
  commandPanels,
} from "@shared/schema";
import { upsertReportSection } from "../storage/reportStorage";
import { applyActiveProductsFilter } from "../../shared/marketingWriteBoundary";
import {
  resolveEffectiveProducts,
  type CanonicalProduct,
} from "../../shared/productResolution";

type Db = ReturnType<typeof import("../db").getDb>;

// ─── Gap 1: missing canonical section rows ──────────────────────────

export const CANONICAL_SECTION_KEYS = [
  "intake",
  "sales",
  "marketing",
  "nextActions",
] as const;

/** Matches the deleted script's stamp so the two eras are distinguishable. */
export const EMPTY_SECTION_EDITOR = "system:backfill_empty_sections";

export interface MissingSectionsScan {
  totalReports: number;
  /** reportId → canonical keys with no report_sections row. */
  missingByReport: Map<string, string[]>;
  missingRowCount: number;
}

export async function scanMissingCanonicalSections(
  db: Db,
): Promise<MissingSectionsScan> {
  const allReports = await db.select({ id: reports.id }).from(reports);
  const allSections = await db
    .select({
      reportId: reportSections.reportId,
      sectionKey: reportSections.sectionKey,
    })
    .from(reportSections);

  const haveByReport = new Map<string, Set<string>>();
  for (const s of allSections) {
    let set = haveByReport.get(s.reportId);
    if (!set) {
      set = new Set();
      haveByReport.set(s.reportId, set);
    }
    set.add(s.sectionKey);
  }

  const missingByReport = new Map<string, string[]>();
  let missingRowCount = 0;
  for (const r of allReports) {
    const have = haveByReport.get(r.id) ?? new Set<string>();
    const missing = CANONICAL_SECTION_KEYS.filter((k) => !have.has(k));
    if (missing.length > 0) {
      missingByReport.set(r.id, missing);
      missingRowCount += missing.length;
    }
  }
  return { totalReports: allReports.length, missingByReport, missingRowCount };
}

export interface EmptySectionBackfillResult {
  inserted: number;
  /** Rows that raced a concurrent save and were skipped by ON CONFLICT. */
  skippedExisting: number;
}

/**
 * Inserts the missing empty section rows. Deliberately NOT via
 * `upsertReportSection`: the upsert path would clobber a section a user
 * saved between scan and write with `{}`. Instead we `ON CONFLICT DO
 * NOTHING` (identical to the retired script) and add the matching baseline
 * `report_section_history` row ONLY for rows we actually inserted — so the
 * edit-history dialog is never empty for rows this backfill creates, and a
 * concurrent real save always wins.
 */
export async function applyEmptySectionBackfill(
  db: Db,
): Promise<EmptySectionBackfillResult> {
  const scan = await scanMissingCanonicalSections(db);
  const now = new Date();
  let inserted = 0;
  let skippedExisting = 0;

  for (const [reportId, keys] of scan.missingByReport) {
    for (const sectionKey of keys) {
      const rows = await db
        .insert(reportSections)
        .values({
          reportId,
          sectionKey,
          data: {},
          lastEditedBy: EMPTY_SECTION_EDITOR,
          lastEditSource: "migration_seed",
          lastEditAt: now,
        })
        .onConflictDoNothing({
          target: [reportSections.reportId, reportSections.sectionKey],
        })
        .returning({ id: reportSections.id });

      if (rows.length === 0) {
        skippedExisting++;
        continue;
      }
      await db.insert(reportSectionHistory).values({
        reportSectionId: rows[0].id,
        reportId,
        sectionKey,
        previousData: null,
        newData: {},
        dataChanged: false,
        editedBy: EMPTY_SECTION_EDITOR,
        editSource: "migration_seed",
        webhookImportLogId: null,
      });
      inserted++;
    }
  }
  return { inserted, skippedExisting };
}

// ─── Gap 2: sections with no edit history (Task #829 baseline seed) ─

export const HISTORY_SEED_WEBHOOK_EDITOR = "system:pdf-webhook";

export async function countSectionsWithoutHistory(db: Db): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM report_sections s
    LEFT JOIN report_section_history h
      ON h.report_id = s.report_id AND h.section_key = s.section_key
    WHERE h.id IS NULL
  `);
  const rows = (result as any).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

export interface HistorySeedResult {
  seeded: number;
  attributed: number;
  unknown: number;
}

/**
 * Faithful port of the retired Task #829 script: for every section with NO
 * history rows, insert exactly one baseline entry capturing the current
 * `data` snapshot, attributing it to the report's webhook import log when
 * one can be found (direct id, else same client + report month), otherwise
 * `unknown`/`migration_seed`; then backfill the live row's `last_edited_*`
 * columns only where still NULL. Idempotent — seeded sections drop out of
 * the anti-join.
 */
export async function applySectionHistorySeed(db: Db): Promise<HistorySeedResult> {
  const result = await db.execute(sql`
    SELECT s.id, s.report_id, s.section_key, s.data, s.updated_at,
           r.client_id, r.report_month, r.webhook_import_log_id
    FROM report_sections s
    JOIN reports r ON r.id = s.report_id
    LEFT JOIN report_section_history h
      ON h.report_id = s.report_id AND h.section_key = s.section_key
    WHERE h.id IS NULL
    ORDER BY s.report_id, s.section_key
  `);
  const sections = ((result as any).rows ?? []) as Array<{
    id: string;
    report_id: string;
    section_key: string;
    data: unknown;
    updated_at: string | null;
    client_id: string;
    report_month: string;
    webhook_import_log_id: string | null;
  }>;

  let attributed = 0;
  let unknown = 0;

  for (const section of sections) {
    let webhookLog: { id: string; created_at: string | null } | null = null;
    if (section.webhook_import_log_id) {
      const direct = await db.execute(sql`
        SELECT id, created_at FROM webhook_import_logs
        WHERE id = ${section.webhook_import_log_id}
      `);
      webhookLog = ((direct as any).rows ?? [])[0] ?? null;
    }
    if (!webhookLog) {
      const matches = await db.execute(sql`
        SELECT id, created_at
        FROM webhook_import_logs
        WHERE client_id = ${section.client_id}
          AND report_month = ${section.report_month}
          AND status = 'success'
        ORDER BY created_at ASC
        LIMIT 1
      `);
      webhookLog = ((matches as any).rows ?? [])[0] ?? null;
    }

    const editedBy = webhookLog ? HISTORY_SEED_WEBHOOK_EDITOR : "unknown";
    const editSource = webhookLog ? "pdf_webhook" : "unknown";
    const editedAt =
      webhookLog?.created_at ?? section.updated_at ?? new Date().toISOString();
    if (webhookLog) attributed++;
    else unknown++;

    await db.execute(sql`
      INSERT INTO report_section_history (
        report_section_id, report_id, section_key, previous_data, new_data,
        data_changed, edited_by, edit_source, webhook_import_log_id, created_at
      ) VALUES (
        ${section.id}, ${section.report_id}, ${section.section_key}, NULL,
        ${JSON.stringify(section.data)}::jsonb, ${false},
        ${editedBy}, ${editSource}, ${webhookLog?.id ?? null}, ${editedAt}
      )
    `);
    await db.execute(sql`
      UPDATE report_sections
      SET last_edited_by = COALESCE(last_edited_by, ${editedBy}),
          last_edit_source = COALESCE(last_edit_source, ${editSource}),
          last_edit_at = COALESCE(last_edit_at, ${editedAt}::timestamp)
      WHERE id = ${section.id}
    `);
  }

  return { seeded: sections.length, attributed, unknown };
}

// ─── Gap 3: inactive-product blocks in stored marketing sections ────

export const INACTIVE_PRODUCT_CLEANUP_EDITOR =
  "system:inactive_products_cleanup";

export interface InactiveProductResidueScan {
  scanned: number;
  /** Sections whose sanitized payload differs AND whose client resolves. */
  actionable: Array<{
    sectionId: string;
    reportId: string;
    clientId: string;
    removedKeys: string[];
  }>;
  /**
   * Dirty sections whose Active-Products resolution is "none" (no CP row,
   * empty clients.products). The retired script refused these without
   * --force; the prod action ALWAYS skips them (an empty active set would
   * zero every platform block). Surfaced in status detail, never counted
   * as pending work.
   */
  unresolvedSkipped: number;
}

/**
 * Bulk re-implementation of the retired script's per-row loop (one query
 * per table instead of 3 queries per section — status() runs on every CEO
 * panel load). Resolution rule is canonical Task #1028: an existing
 * command_panels row wins (even with empty productTypes); otherwise
 * clients.products; otherwise "none".
 */
export async function scanInactiveProductResidue(
  db: Db,
): Promise<InactiveProductResidueScan> {
  const rows = await db
    .select({
      sectionId: reportSections.id,
      reportId: reportSections.reportId,
      data: reportSections.data,
      clientId: reports.clientId,
    })
    .from(reportSections)
    .innerJoin(reports, eq(reports.id, reportSections.reportId))
    .where(eq(reportSections.sectionKey, "marketing"));

  const out: InactiveProductResidueScan = {
    scanned: rows.length,
    actionable: [],
    unresolvedSkipped: 0,
  };
  if (rows.length === 0) return out;

  const clientRows = await db
    .select({ id: clientsTable.id, products: clientsTable.products })
    .from(clientsTable);
  const cpRows = await db
    .select({
      clientId: commandPanels.clientId,
      productTypes: commandPanels.productTypes,
    })
    .from(commandPanels);
  const productsByClient = new Map(clientRows.map((c) => [c.id, c.products]));
  const cpByClient = new Map(cpRows.map((c) => [c.clientId, c]));

  for (const row of rows) {
    const cp = cpByClient.get(row.clientId) ?? null;
    const clientProducts = productsByClient.get(row.clientId) ?? null;
    let active: CanonicalProduct[];
    let source: "command_panel" | "client_products" | "none";
    if (cp != null) {
      active = resolveEffectiveProducts(cp, clientProducts);
      source = "command_panel";
    } else if (Array.isArray(clientProducts) && clientProducts.length > 0) {
      active = resolveEffectiveProducts(null, clientProducts);
      source = "client_products";
    } else {
      active = [];
      source = "none";
    }

    const cloned = JSON.parse(JSON.stringify(row.data ?? {}));
    const result = applyActiveProductsFilter(cloned, active, {
      source: "prod_action_scan",
      clientId: row.clientId,
      reportId: row.reportId,
    });
    const meaningful = result.removed.filter((r) => r.hadData);
    if (meaningful.length === 0) continue;

    if (source === "none") {
      out.unresolvedSkipped++;
      continue;
    }
    out.actionable.push({
      sectionId: row.sectionId,
      reportId: row.reportId,
      clientId: row.clientId,
      removedKeys: meaningful.map((r) => `${r.product}/${r.key}`),
    });
  }
  return out;
}

export interface InactiveProductCleanupResult {
  cleaned: number;
  /** Fresh re-read showed the row was already clean (concurrent save). */
  skippedAlreadyClean: number;
  unresolvedSkipped: number;
}

/**
 * F3-caveat closure: every mutation goes through `upsertReportSection`
 * (the audited section writer), so each cleaned section gains a
 * `report_section_history` entry with previous/new data — fully
 * operator-reversible from the edit-history dialog. Each row is re-read
 * and re-filtered immediately before writing so a save that landed after
 * the scan is never clobbered with stale data.
 */
export async function applyInactiveProductCleanup(
  db: Db,
): Promise<InactiveProductCleanupResult> {
  const scan = await scanInactiveProductResidue(db);
  let cleaned = 0;
  let skippedAlreadyClean = 0;

  for (const item of scan.actionable) {
    const [fresh] = await db
      .select({ data: reportSections.data, clientId: reports.clientId })
      .from(reportSections)
      .innerJoin(reports, eq(reports.id, reportSections.reportId))
      .where(
        and(
          eq(reportSections.id, item.sectionId),
          eq(reportSections.sectionKey, "marketing"),
        ),
      );
    if (!fresh) {
      skippedAlreadyClean++;
      continue;
    }

    // Re-resolve products fresh too (a CP fix between scan and apply must
    // be honored).
    const [client] = await db
      .select({ products: clientsTable.products })
      .from(clientsTable)
      .where(eq(clientsTable.id, fresh.clientId));
    const [cp] = await db
      .select({ productTypes: commandPanels.productTypes })
      .from(commandPanels)
      .where(eq(commandPanels.clientId, fresh.clientId));

    let active: CanonicalProduct[];
    if (cp != null) {
      active = resolveEffectiveProducts(cp, client?.products ?? null);
    } else if (Array.isArray(client?.products) && client.products.length > 0) {
      active = resolveEffectiveProducts(null, client.products);
    } else {
      // Resolution decayed to "none" since the scan — skip (never zero
      // every block).
      skippedAlreadyClean++;
      continue;
    }

    const cloned = JSON.parse(JSON.stringify(fresh.data ?? {}));
    const result = applyActiveProductsFilter(cloned, active, {
      source: "prod_action_cleanup",
      clientId: fresh.clientId,
      reportId: item.reportId,
    });
    if (result.removed.filter((r) => r.hadData).length === 0) {
      skippedAlreadyClean++;
      continue;
    }

    await upsertReportSection(
      { reportId: item.reportId, sectionKey: "marketing", data: cloned },
      { editor: INACTIVE_PRODUCT_CLEANUP_EDITOR, source: "system" },
    );
    cleaned++;
  }

  return {
    cleaned,
    skippedAlreadyClean,
    unresolvedSkipped: scan.unresolvedSkipped,
  };
}
