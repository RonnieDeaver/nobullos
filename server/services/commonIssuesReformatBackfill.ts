// @db-pool-intent: ambient
/**
 * Task #2390 — shared core for the "reformat Common Issues on ALL reports"
 * backfill.
 *
 * Background:
 *   Task #2389 shipped `commonIssuesFormatter.ts`
 *   (`formatCommonIssuesContent` → 🔴 Issue / ↳ Impact / ➡️ Strategic Fix,
 *   with OCR-artifact cleanup and a never-throws deterministic fallback) so
 *   NEW imports are clean by default. Historical reports saved before that —
 *   and even reports formatted by an earlier version of the prompt — still
 *   show raw OCR run-on text and spacing junk. Per CEO decision the new
 *   formatter is applied retroactively to the ENTIRE back catalog, re-running
 *   EVERY Intake/Sales Common Issues section through the AI (including ones
 *   that already look formatted, since the new pass may improve them).
 *
 *   This module re-runs `formatCommonIssuesContent(text, "intake"|"sales")`
 *   for one `report_sections` row and writes the formatted result plus a
 *   convergence stamp (`data.commonIssuesReformatBackfillVersion`) so the
 *   action settles to "not needed" after one pass. It is consumed by two
 *   callers that share this exact logic so they stay in lockstep:
 *     - `scripts/backfill-common-issues-reformat.ts` (CLI, dry-run by
 *       default) — for dev inspection of candidate counts.
 *     - the `reformat_common_issues_all_reports` CEO prod-action in
 *       `prodActionsRegistry.ts` — one-press background drain against the
 *       deployed Neon database (dev can only read prod).
 *
 * Safety / behavior:
 *   - Empty / "missing data source" placeholder sections are left untouched
 *     (existing `isEmptySectionBody` / `isAiRewrittenMissingDataSourceFinding`
 *     guards). They are filtered out of the candidate set in code, so they
 *     are never written AND never block convergence (the count excludes them).
 *   - Convergence: every section this backfill processes is stamped with the
 *     current `COMMON_ISSUES_REFORMAT_BACKFILL_VERSION`. Candidate selection
 *     skips already-stamped sections, so a second Apply-all does not re-bill
 *     AI on the whole catalog. A future explicit reset / version bump is the
 *     only way to re-run.
 *   - Degrades safely: `formatCommonIssuesContent` never throws — on any AI
 *     failure it returns the deterministic fallback, so the drain continues.
 *   - Never destroys content: a formatted result is only written when it is
 *     non-empty; otherwise the original `commonIssues` is preserved and only
 *     the stamp is written (still converges).
 *   - Pool-agnostic: the Drizzle handle is injected so the CLI can use the
 *     process `workerDb` and the prod-action can use the `worker` pool via
 *     `getDb()` under `runWithWorkerDb`.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { reportSections, reports, clients } from "@shared/schema";
import { isMissingDataSourceDerivedBody } from "./pdfImportParser";
import {
  formatCommonIssuesContent,
  needsCommonIssuesStructureRepair,
  normalizeCommonIssuesStructure,
  type CommonIssuesMetricContext,
} from "./commonIssuesFormatter";

// Type-only — erased at runtime, so importing this module does NOT boot the
// DB pool. Callers inject the concrete handle.
export type BackfillDb = ReturnType<typeof import("../db")["getDb"]>;

/**
 * Current backfill version. Bumping this re-arms the whole catalog (every
 * section's stamp becomes stale, so it is re-counted and re-processed). The
 * stamp is stored as this number under `data.commonIssuesReformatBackfillVersion`.
 */
export const COMMON_ISSUES_REFORMAT_BACKFILL_VERSION = 1;

export const REFORMAT_STAMP_KEY = "commonIssuesReformatBackfillVersion";

const TARGET_SECTION_KEYS = ["intake", "sales"] as const;

export interface ReformatCandidate {
  id: string;
  reportId: string;
  sectionKey: "intake" | "sales";
  commonIssues: string;
  data: Record<string, unknown>;
  /**
   * Task #2460 — performance context for tone scaling, resolved per candidate
   * at selection time (the section's conversion rate + the client's consult
   * type). Undefined when the rate/consult type can't be resolved → neutral
   * tone, identical to the pre-#2460 behavior.
   */
  metricContext?: CommonIssuesMetricContext;
  /**
   * Task #3770 — true when the stored text is the malformed single-line
   * marker shape (canonical 🔴/↳/➡️ markers, no line breaks, normalization
   * would change it). Such rows are repaired via the deterministic structure
   * normalizer — never a fresh AI pass — and qualify as candidates even when
   * already stamped (targeted revival that self-extinguishes once the text
   * gains line breaks).
   */
  structureRepairOnly?: boolean;
}

/**
 * Returns the report_sections rows that still need a reformat pass: Intake /
 * Sales sections whose `data.commonIssues` is a non-empty, non-placeholder
 * string AND whose stamp is missing or older than the current version.
 *
 * The SQL prefilter narrows to non-empty + unstamped rows; the
 * placeholder/empty guards run in code (they are regex detectors that cannot
 * be expressed cleanly in SQL). Placeholder rows therefore never appear as
 * candidates — they are left untouched and do not block convergence.
 */
export async function findReformatCandidateSections(
  db: BackfillDb,
  opts: { clientId?: string } = {},
): Promise<ReformatCandidate[]> {
  const version = COMMON_ISSUES_REFORMAT_BACKFILL_VERSION;
  // Task #2460 — join through reports → clients so each candidate carries the
  // client's consult type for performance-aware tone. The section's own
  // conversion rate already lives in `data` (leadToConsultRate /
  // consultToCaseRate), so it doesn't need a separate column.
  const conditions = [
    inArray(reportSections.sectionKey, [...TARGET_SECTION_KEYS]),
    // Non-empty commonIssues string.
    sql`COALESCE(${reportSections.data} ->> 'commonIssues', '') <> ''`,
    // Stamp missing or stale (older version) — OR (Task #3770) the stored
    // text is the malformed single-line marker shape: imports stamp at write
    // time (Task #3533), so a poisoned row can be stamped-current and would
    // otherwise be skipped forever. The revival arm fetches single-line rows
    // bearing canonical markers; the code loop below re-checks them with the
    // precise `needsCommonIssuesStructureRepair` detector so healthy short
    // single-line rows never re-arm the action (convergence).
    sql`(
      COALESCE((${reportSections.data} ->> ${REFORMAT_STAMP_KEY})::int, 0) <> ${version}
      OR (
        POSITION(CHR(10) IN COALESCE(${reportSections.data} ->> 'commonIssues', '')) = 0
        AND (
          ${reportSections.data} ->> 'commonIssues' LIKE '%🔴%'
          OR ${reportSections.data} ->> 'commonIssues' LIKE '%↳%'
          OR ${reportSections.data} ->> 'commonIssues' LIKE '%Strategic Fix:%'
        )
      )
    )`,
  ];
  if (opts.clientId) {
    conditions.push(eq(reports.clientId, opts.clientId));
  }

  const rows = await db
    .select({
      id: reportSections.id,
      reportId: reportSections.reportId,
      sectionKey: reportSections.sectionKey,
      data: reportSections.data,
      consultType: clients.consultType,
    })
    .from(reportSections)
    .innerJoin(reports, eq(reportSections.reportId, reports.id))
    .leftJoin(clients, eq(reports.clientId, clients.id))
    .where(and(...conditions));

  const candidates: ReformatCandidate[] = [];
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const commonIssues =
      typeof data.commonIssues === "string" ? (data.commonIssues as string) : "";
    if (!commonIssues.trim()) continue;
    // Leave empty / "missing data source" placeholder sections untouched
    // (all derived classes, Task #3901 included).
    if (isMissingDataSourceDerivedBody(commonIssues)) {
      continue;
    }
    // Task #3770 — precise malformed-shape check + stamped-row gate. Rows
    // fetched ONLY by the revival arm (stamp already current) qualify solely
    // when the normalizer would actually change them; anything else stamped-
    // current is healthy (e.g. a legitimately short one-line block) and must
    // NOT become a perpetual candidate.
    const structureRepairOnly = needsCommonIssuesStructureRepair(commonIssues);
    const stampCurrent =
      Number((data as Record<string, unknown>)[REFORMAT_STAMP_KEY] ?? 0) ===
      version;
    if (stampCurrent && !structureRepairOnly) continue;
    const sectionKey = row.sectionKey === "sales" ? "sales" : "intake";
    const consultType = row.consultType === "paid" ? "paid" : "free";
    const rawRate =
      sectionKey === "sales" ? data.consultToCaseRate : data.leadToConsultRate;
    const metricContext: CommonIssuesMetricContext | undefined =
      typeof rawRate === "number" && Number.isFinite(rawRate)
        ? { rate: rawRate, consultType }
        : undefined;
    candidates.push({
      id: row.id,
      reportId: row.reportId,
      sectionKey,
      commonIssues,
      data,
      metricContext,
      structureRepairOnly,
    });
  }
  return candidates;
}

export type ProcessReformatResult =
  | { kind: "skipped_placeholder" }
  | {
      kind: "done";
      degraded: boolean;
      reason?: string;
      changed: boolean;
      wroteFormatted: boolean;
      /**
       * Task #3770 — true when the row was repaired via the deterministic
       * structure normalizer (malformed single-line revival), not an AI pass.
       */
      structureRepaired: boolean;
    };

export interface ProcessReformatDeps {
  db: BackfillDb;
  /** When true, write the formatted result + stamp; otherwise compute only. */
  apply: boolean;
}

/**
 * Process a single candidate section: run the shared formatter and (when
 * `apply`) write the formatted `commonIssues` plus the convergence stamp,
 * preserving every other key in `data`. Never throws — the formatter degrades
 * to the deterministic fallback on any AI failure.
 */
export async function processReformatSection(
  deps: ProcessReformatDeps,
  candidate: ReformatCandidate,
): Promise<ProcessReformatResult> {
  const text = candidate.commonIssues;
  // Defensive: candidates are pre-filtered, but never write/format a
  // placeholder if one slips through.
  if (isMissingDataSourceDerivedBody(text)) {
    return { kind: "skipped_placeholder" };
  }

  // Task #3770 — malformed single-line rows are repaired deterministically:
  // the stored text already IS formatter output, only its line structure was
  // lost, so re-inserting the line breaks is strictly safer (and free) vs.
  // re-billing an AI pass that could misbehave again.
  if (candidate.structureRepairOnly) {
    const repaired = normalizeCommonIssuesStructure(text);
    const wroteRepaired = Boolean(repaired && repaired.trim());
    if (deps.apply) {
      const nextData: Record<string, unknown> = {
        ...candidate.data,
        [REFORMAT_STAMP_KEY]: COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
      };
      if (wroteRepaired) nextData.commonIssues = repaired;
      await deps.db
        .update(reportSections)
        .set({ data: nextData })
        .where(eq(reportSections.id, candidate.id));
    }
    return {
      kind: "done",
      degraded: false,
      changed: wroteRepaired && repaired !== text,
      wroteFormatted: wroteRepaired,
      structureRepaired: true,
    };
  }

  const result = await formatCommonIssuesContent(
    text,
    candidate.sectionKey,
    candidate.metricContext,
  );
  const formatted = result.formatted;
  const wroteFormatted = Boolean(formatted && formatted.trim());
  const changed = wroteFormatted && formatted !== text;

  if (deps.apply) {
    const nextData: Record<string, unknown> = {
      ...candidate.data,
      [REFORMAT_STAMP_KEY]: COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
    };
    // Only overwrite content with a non-empty formatted result; otherwise
    // keep the original (never destroy a real finding) and just stamp it.
    if (wroteFormatted) nextData.commonIssues = formatted;
    await deps.db
      .update(reportSections)
      .set({ data: nextData })
      .where(eq(reportSections.id, candidate.id));
  }

  return {
    kind: "done",
    degraded: result.degraded,
    reason: result.reason,
    changed,
    wroteFormatted,
    structureRepaired: false,
  };
}
