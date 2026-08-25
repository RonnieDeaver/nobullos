// @db-pool-intent: worker
/**
 * Task #3772 (extension) — Heal fabricated unflagged zeros on PAST
 * webhook-imported reports.
 *
 * Background: before Task #3772, the PDF webhook import wrote every numeric
 * intake/sales metric as `parsed.x || 0` with NO noDataFlags. Sections it
 * created therefore held bare 0s for every metric the parser missed:
 *
 *   - Untouched sections have no `noDataFlags` object at all (legacy era) —
 *     the report renders "No Data" for those 0s, which is honest but
 *     fragile: the NEXT operator form-save stamps a full all-false flags
 *     object and silently converts every missed metric into a fabricated
 *     "entered zero" ("0s · Healthy").
 *   - Sections the operator re-saved after import already carry that
 *     all-false flags object today (e.g. Ackah Law 2026-07, Jurist Law
 *     Group 2026-06/07): the public report shows healthy zeros the PDF
 *     never contained.
 *
 * This module computes and applies the retroactive fix, per field:
 *
 *   FILL — the stored extracted text of the report's latest successful
 *          import, re-parsed with the CURRENT parser (which now knows the
 *          "Time to Human Answer" label), yields the metric → write the
 *          real value with `noDataFlags[field] = false` (entered, with
 *          parse evidence).
 *   FLAG — still no parse evidence → set `noDataFlags[field] = true` so the
 *          section renders (and keeps rendering) "No Data" for it.
 *
 * Safety rails — a field is only touched when ALL hold:
 *   1. Its current state is the fabricated signature: value 0/absent AND
 *      flag !== true.
 *   2. The ORIGINAL import recorded no parse evidence for it
 *      (`buildImportedSectionNoDataFlags(loggedConfidence)[field] === true`).
 *      Evidence-backed zeros are genuine PDF zeros and stay untouched.
 *   3. Section history proves no human ever changed the field: every
 *      non-import edit kept the value identical and never touched a
 *      No-Data flag `true` state for it (the era-conversion save that adds
 *      an all-false flags object without changing values counts as clean —
 *      that IS the fabrication moment, not an operator decision).
 *
 * Everything else — non-zero values, flag=true fields, operator-changed
 * fields, evidence-backed zeros — is reported but never written.
 *
 * Exposed via the `heal_imported_fabricated_zero_metrics` prod-action in
 * `prodActionsRegistry.ts` (manual-only, one press heals everything).
 */
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { storage } from "../storage";
import { bindArrayParam } from "../utils/sqlArray";
import {
  ENTRY_TRACKED_IMPORT_METRICS,
  type EntryTrackedImportSection,
} from "@shared/importMetricPresence";
import { buildImportedSectionNoDataFlags } from "./importWritePolicy";
import { parseReportText } from "./pdfImportParser";

/** Editor stamp for section writes made by this healer. */
export const IMPORT_ZERO_HEAL_EDITOR = "system:import-zero-heal";

// ─── Pure plan computation ───────────────────────────────────────────

export type HealFieldAction =
  /** Re-parse found the metric — write value + flag false. */
  | "fill"
  /** Still no evidence — set the No-Data flag true. */
  | "flag"
  /** A human changed this field after import — never touch. */
  | "skip_dirty"
  /** Original import had parse evidence for the 0 — genuine value. */
  | "skip_evidence"
  /** Not in the fabricated state (non-zero, or already flagged). */
  | "ok";

export interface HealFieldDecision {
  field: string;
  action: HealFieldAction;
  /** Present for `fill`. */
  value?: number;
}

export interface SectionHistoryRowLike {
  editSource: string | null;
  editedBy: string | null;
  previousData: unknown;
  newData: unknown;
}

export interface SectionHealPlan {
  decisions: HealFieldDecision[];
  /** True when at least one field needs fill/flag. */
  changed: boolean;
  /** Section data with fills + flag patches applied (only when changed). */
  newData?: Record<string, unknown>;
}

/** 0 / "0" / "0.0" / "" / null / undefined / NaN → no real value. */
function numericValue(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isZeroish(v: unknown): boolean {
  const n = numericValue(v);
  return n === null || n === 0;
}

function flagsOf(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const flags = (data as Record<string, unknown>).noDataFlags;
  return flags && typeof flags === "object" ? (flags as Record<string, unknown>) : {};
}

function fieldOf(data: unknown, field: string): unknown {
  if (!data || typeof data !== "object") return undefined;
  return (data as Record<string, unknown>)[field];
}

/**
 * True when a history row is an import-pipeline write (or one of our own
 * heal writes) rather than a human/system edit that could express intent.
 */
function isImportWrite(row: SectionHistoryRowLike): boolean {
  return row.editSource === "pdf_webhook" || row.editedBy === IMPORT_ZERO_HEAL_EDITOR;
}

/**
 * A field is "dirty" when any non-import edit changed its value, or moved
 * its No-Data flag through `true` in either direction. The era-conversion
 * save (flags absent → false, value unchanged) is clean by design.
 */
function fieldTouchedByHuman(historyRows: SectionHistoryRowLike[], field: string): boolean {
  for (const row of historyRows) {
    if (isImportWrite(row)) continue;
    const prevVal = numericValue(fieldOf(row.previousData, field));
    const newVal = numericValue(fieldOf(row.newData, field));
    if (prevVal !== newVal) return true;
    const prevFlag = flagsOf(row.previousData)[field] === true;
    const newFlag = flagsOf(row.newData)[field] === true;
    if (prevFlag !== newFlag) return true;
  }
  return false;
}

export interface ComputeSectionHealPlanInput {
  sectionKey: EntryTrackedImportSection;
  /** Current report_sections.data for the section. */
  sectionData: Record<string, unknown>;
  /** Full history for the section, oldest first. */
  historyRows: SectionHistoryRowLike[];
  /** field_confidence of the report's latest successful import log. */
  loggedConfidence: Record<string, unknown> | null;
  /**
   * Re-parse of that log's stored extracted text with the CURRENT parser,
   * or null when unavailable (older logs without stored text) or when the
   * caller only needs the pending count (status path) — null downgrades
   * every heal to `flag`… except it does NOT: with null, healable fields
   * are still reported, but as `flag`, since no fill value exists.
   */
  freshParse: ReturnType<typeof parseReportText> | null;
}

export function computeSectionHealPlan(input: ComputeSectionHealPlanInput): SectionHealPlan {
  const { sectionKey, sectionData, historyRows, loggedConfidence, freshParse } = input;
  const fields = ENTRY_TRACKED_IMPORT_METRICS[sectionKey];
  const currentFlags = flagsOf(sectionData);
  const loggedFlags = buildImportedSectionNoDataFlags(loggedConfidence ?? undefined, sectionKey);
  const freshFlags = freshParse
    ? buildImportedSectionNoDataFlags(freshParse.fieldConfidence, sectionKey)
    : null;
  const freshSection = freshParse
    ? ((freshParse as unknown as Record<string, unknown>)[sectionKey] as
        | Record<string, unknown>
        | undefined)
    : undefined;

  const decisions: HealFieldDecision[] = [];
  for (const field of fields) {
    // 1) Fabricated signature: 0/absent value AND flag not true.
    if (!isZeroish(sectionData[field]) || currentFlags[field] === true) {
      decisions.push({ field, action: "ok" });
      continue;
    }
    // 2) Evidence-backed zero from the original parse → genuine, keep.
    if (loggedFlags[field] === false) {
      decisions.push({ field, action: "skip_evidence" });
      continue;
    }
    // 3) A human changed the field after import → their call, keep.
    if (fieldTouchedByHuman(historyRows, field)) {
      decisions.push({ field, action: "skip_dirty" });
      continue;
    }
    // 4) Heal: fill from the re-parse when it now has evidence, else flag.
    if (freshFlags && freshFlags[field] === false) {
      const value = numericValue(freshSection?.[field]) ?? 0;
      decisions.push({ field, action: "fill", value });
    } else {
      decisions.push({ field, action: "flag" });
    }
  }

  const healed = decisions.filter((d) => d.action === "fill" || d.action === "flag");
  if (healed.length === 0) return { decisions, changed: false };

  // Patch ONLY the healed keys into noDataFlags. Untouched fields keep their
  // era: adding `false` for them would fabricate "entered zeros" — the exact
  // bug this heals. (See shared/importMetricPresence.ts header.)
  const patchedFlags: Record<string, unknown> = { ...currentFlags };
  const newData: Record<string, unknown> = { ...sectionData };
  for (const d of healed) {
    if (d.action === "fill") {
      newData[d.field] = d.value;
      patchedFlags[d.field] = false;
    } else {
      patchedFlags[d.field] = true;
    }
  }
  newData.noDataFlags = patchedFlags;
  return { decisions, changed: true, newData };
}

// ─── Cohort enumeration + driver ─────────────────────────────────────

export interface HealFieldRecord {
  reportId: string;
  clientName: string;
  reportMonth: string;
  reportStatus: string;
  sectionKey: string;
  field: string;
  value?: number;
}

export interface ImportedZeroHealSummary {
  reportsScanned: number;
  sectionsScanned: number;
  /** Sections written (0 in dry-run mode even when pending > 0). */
  sectionsHealed: number;
  filled: HealFieldRecord[];
  flagged: HealFieldRecord[];
  skippedDirty: HealFieldRecord[];
  /** fill+flag field count — the action's pending number. */
  pendingFields: number;
}

interface CohortRow {
  report_id: string;
  report_status: string;
  report_month: string;
  client_name: string;
  log_id: string;
  field_confidence: Record<string, unknown> | null;
  pdf_extracted_text: string | null;
}

interface SectionRow {
  report_id: string;
  section_key: string;
  data: Record<string, unknown>;
}

interface HistoryRow {
  report_id: string;
  section_key: string;
  edit_source: string | null;
  edited_by: string | null;
  previous_data: unknown;
  new_data: unknown;
}

export interface RunImportedZeroHealOptions {
  /** Compute only — never write. */
  dryRun: boolean;
  /**
   * Re-parse stored extracted text so misses can become FILLs. The status
   * path skips this (skips even SELECTing the large text column); apply
   * always re-parses.
   */
  reparse: boolean;
}

/** In-process re-entrancy guard; a concurrent duplicate run is a no-op
 * anyway (it would recompute an already-healed cohort), this just avoids
 * doubled history rows from a double-press racing on one instance. */
let healRunning = false;

export async function runImportedZeroHeal(
  options: RunImportedZeroHealOptions,
): Promise<ImportedZeroHealSummary> {
  const { dryRun, reparse } = options;
  if (!dryRun && healRunning) {
    throw new Error("Imported-zero heal is already running on this instance.");
  }
  if (!dryRun) healRunning = true;
  try {
    return await runImportedZeroHealInner(dryRun, reparse);
  } finally {
    if (!dryRun) healRunning = false;
  }
}

async function runImportedZeroHealInner(
  dryRun: boolean,
  reparse: boolean,
): Promise<ImportedZeroHealSummary> {
  // Latest successful import log per report — its confidence is the
  // parse-evidence record; its stored text is the re-parse source.
  const textColumn = reparse
    ? sql`w.pdf_extracted_text`
    : sql`NULL::text AS pdf_extracted_text`;
  const cohortResult = await withDbAttribution("maintenance:import-zero-heal:cohort", () =>
    getDb().execute(sql`
      SELECT DISTINCT ON (w.report_id)
        w.report_id, w.client_name, w.report_month, w.id AS log_id,
        w.field_confidence, ${textColumn},
        r.status AS report_status
      FROM webhook_import_logs w
      JOIN reports r ON r.id = w.report_id
      WHERE w.status = 'success' AND w.report_id IS NOT NULL
      ORDER BY w.report_id, w.created_at DESC, w.id DESC
    `),
  );
  const cohort = cohortResult.rows as unknown as CohortRow[];
  const byReport = new Map(cohort.map((c) => [c.report_id, c]));
  const reportIds = [...byReport.keys()];

  const summary: ImportedZeroHealSummary = {
    reportsScanned: reportIds.length,
    sectionsScanned: 0,
    sectionsHealed: 0,
    filled: [],
    flagged: [],
    skippedDirty: [],
    pendingFields: 0,
  };
  if (reportIds.length === 0) return summary;

  const sectionsResult = await withDbAttribution("maintenance:import-zero-heal:sections", () =>
    getDb().execute(sql`
      SELECT report_id, section_key, data
      FROM report_sections
      WHERE section_key IN ('intake', 'sales')
        AND report_id = ANY(${bindArrayParam(reportIds, "varchar")})
    `),
  );
  const sections = sectionsResult.rows as unknown as SectionRow[];

  const historyResult = await withDbAttribution("maintenance:import-zero-heal:history", () =>
    getDb().execute(sql`
      SELECT report_id, section_key, edit_source, edited_by, previous_data, new_data
      FROM report_section_history
      WHERE section_key IN ('intake', 'sales')
        AND report_id = ANY(${bindArrayParam(reportIds, "varchar")})
      ORDER BY created_at ASC, id ASC
    `),
  );
  const historyBySection = new Map<string, SectionHistoryRowLike[]>();
  for (const row of historyResult.rows as unknown as HistoryRow[]) {
    const key = `${row.report_id}\u0000${row.section_key}`;
    let list = historyBySection.get(key);
    if (!list) {
      list = [];
      historyBySection.set(key, list);
    }
    list.push({
      editSource: row.edit_source,
      editedBy: row.edited_by,
      previousData: row.previous_data,
      newData: row.new_data,
    });
  }

  // Re-parse each report's stored text at most once (intake+sales share it).
  const parseCache = new Map<string, ReturnType<typeof parseReportText> | null>();
  const freshParseFor = (c: CohortRow): ReturnType<typeof parseReportText> | null => {
    if (!reparse) return null;
    let parsed = parseCache.get(c.report_id);
    if (parsed === undefined) {
      const text = c.pdf_extracted_text;
      if (text && text.trim().length >= 100) {
        try {
          parsed = parseReportText(text);
        } catch (err: any) {
          console.error(
            `[import-zero-heal] re-parse failed for report ${c.report_id}: ${err?.message ?? err}`,
          );
          parsed = null;
        }
      } else {
        parsed = null;
      }
      parseCache.set(c.report_id, parsed);
    }
    return parsed;
  };

  for (const section of sections) {
    const cohortRow = byReport.get(section.report_id);
    if (!cohortRow) continue;
    const sectionKey = section.section_key as EntryTrackedImportSection;
    if (sectionKey !== "intake" && sectionKey !== "sales") continue;
    summary.sectionsScanned++;

    const plan = computeSectionHealPlan({
      sectionKey,
      sectionData: section.data ?? {},
      historyRows: historyBySection.get(`${section.report_id}\u0000${sectionKey}`) ?? [],
      loggedConfidence: cohortRow.field_confidence,
      freshParse: freshParseFor(cohortRow),
    });

    const record = (d: HealFieldDecision): HealFieldRecord => ({
      reportId: section.report_id,
      clientName: cohortRow.client_name,
      reportMonth: cohortRow.report_month,
      reportStatus: cohortRow.report_status,
      sectionKey,
      field: d.field,
      ...(d.value !== undefined ? { value: d.value } : {}),
    });
    for (const d of plan.decisions) {
      if (d.action === "fill") summary.filled.push(record(d));
      else if (d.action === "flag") summary.flagged.push(record(d));
      else if (d.action === "skip_dirty") summary.skippedDirty.push(record(d));
    }

    if (plan.changed && !dryRun) {
      await withDbAttribution("maintenance:import-zero-heal:write", () =>
        storage.upsertReportSection(
          {
            reportId: section.report_id,
            sectionKey,
            data: plan.newData as any,
          },
          {
            editor: IMPORT_ZERO_HEAL_EDITOR,
            source: "system",
            webhookImportLogId: cohortRow.log_id,
          },
        ),
      );
      summary.sectionsHealed++;
    }
  }

  summary.pendingFields = summary.filled.length + summary.flagged.length;
  return summary;
}
