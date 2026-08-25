/**
 * Task #4509 (extends Task #4467) — the SINGLE source for the public-report
 * privacy boundary over section-level internal bookkeeping.
 *
 * `report_sections.data` accumulates internal stamps written by backfills /
 * convergence actions (version numbers, outcome markers, operator-lifecycle
 * warnings). None of these may ever reach an anonymous viewer on
 * `/api/share/:token` or `/api/demo-report`. Both public payload builders in
 * server/routes/reports.ts strip EVERY served section through
 * `stripInternalSectionBookkeepingKeys` below.
 *
 * ── Convention for new stamps (guard-enforced) ──────────────────────────
 * When a service stamps a bookkeeping key onto `report_sections.data`:
 *   1. Export the key as a `const NAME = "literalValue"` string constant from
 *      the owning module under server/services (names ending in
 *      `_STAMP_KEY` / `_OUTCOME_KEY` / `_WARNING_KEY`, or camelCase values
 *      ending in `Version` / `Outcome` / `Warning`, are what the guard
 *      detects).
 *   2. Import that constant here and add it to
 *      `PUBLIC_INTERNAL_SECTION_DATA_KEYS` (imports, never re-typed string
 *      literals, so a rename can't silently drift out of the strip list).
 *
 * tests/report-public-stamp-key-guard.test.ts source-scans server/services
 * for constants matching the convention and fails when one is neither in
 * this list nor in its documented allow-list (for stamp-shaped constants
 * that are NOT written to report_sections.data — each allow entry carries a
 * reason). tests/report-public-internal-keys-sanitize.test.ts asserts the
 * end-to-end strip on both public routes.
 */
import { BROKEN_SOURCE_WARNING_KEY } from "./reportImportWarnings";
import { REFORMAT_STAMP_KEY as COMMON_ISSUES_REFORMAT_STAMP_KEY } from "./commonIssuesReformatBackfill";
import {
  JUNE_LEAD_REPARSE_STAMP_KEY,
  JUNE_LEAD_REPARSE_OUTCOME_KEY,
} from "./juneLeadReparse";
import { DEGENERATE_REPAIR_STAMP_KEY } from "./degenerateCommonIssuesRepair";

export const PUBLIC_INTERNAL_SECTION_DATA_KEYS: readonly string[] = [
  BROKEN_SOURCE_WARNING_KEY,
  COMMON_ISSUES_REFORMAT_STAMP_KEY,
  JUNE_LEAD_REPARSE_STAMP_KEY,
  JUNE_LEAD_REPARSE_OUTCOME_KEY,
  // Task #4509 — the Task #4227 degenerate-copy repair stamps intake/sales
  // sections; it was missing from the Task #4467 list (exactly the drift
  // this guard exists to catch) and leaked to anonymous viewers until now.
  DEGENERATE_REPAIR_STAMP_KEY,
  // Unmatched GBP import location names pending operator review (cleared on
  // operator save); a plain string key on marketing sections, no exported
  // constant — reports.ts also strips it inside its marketing sanitizer.
  "gbpUnresolvedImports",
];

/** Deletes every internal bookkeeping key in place (same-reference, no clone). */
export function stripInternalSectionBookkeepingKeys(
  sanitizedData: Record<string, unknown>,
): void {
  for (const key of PUBLIC_INTERNAL_SECTION_DATA_KEYS) {
    delete sanitizedData[key];
  }
}
