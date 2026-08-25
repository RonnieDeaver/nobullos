/**
 * Pure helpers for keeping report.marketing.gbp.locations identity stable.
 *
 * These live in their own module (rather than inside ReportForm.tsx) so they
 * can be unit-tested from node without dragging in the React page's UI
 * dependencies (maplibre, recharts, etc).
 *
 * Matching against the Command Panel is delegated to the shared, framework-free
 * matcher in `@shared/gbpLocationMatch` so the client report builder and the
 * server webhook import path resolve names IDENTICALLY (see that module's
 * header for why divergent matchers caused foreign-location ghosts).
 */

import {
  normalizeGbpLocationName as sharedNormalize,
  gbpNameMatches,
  matchCommandPanelLocation,
} from "@shared/gbpLocationMatch";

export type GbpLocationLite = {
  id: string;
  name: string;
  uniqueLeads?: number;
  reviewsGenerated?: number;
  reviewsRespondedTo?: number;
  postsQaCount?: number;
  heatmapImageUrl?: string;
  heatmapSnapshotId?: string;
  heatmapSnapshotIds?: string[];
  leadQuality?: { good?: number; notQuotable?: number; missedCalls?: number; noData?: number };
  [k: string]: any;
};

export type CommandPanelLocationLite = { id: string; name: string };

/** Result of merging an imported batch into a report's existing GBP rows. */
export type MergeImportedResult = {
  /** Rows safe to persist — each resolves to an existing report row or a Command Panel location. */
  merged: GbpLocationLite[];
  /**
   * Imported rows that resolved to NEITHER an existing report row NOR a Command
   * Panel location. These are intentionally NOT merged into `merged`; the caller
   * must surface them to the operator (e.g. the "Add to command panel" affordance)
   * rather than silently creating a misleading ghost entry.
   */
  unresolved: GbpLocationLite[];
};

export function normalizeGbpLocationName(name: string): string {
  return sharedNormalize(name);
}

/**
 * In-batch dedupe used by both the live import path and the merge helper.
 * Two rows whose normalized names match are collapsed; numeric metrics are
 * summed into the first occurrence.
 */
export function deduplicateGbpLocations(locations: any[]): any[] {
  const deduped: any[] = [];
  for (const loc of locations) {
    const existing = deduped.find(
      d => normalizeGbpLocationName(d.name || '') === normalizeGbpLocationName(loc.name || ''),
    );
    if (existing) {
      existing.uniqueLeads = (existing.uniqueLeads || 0) + (loc.uniqueLeads || 0);
      existing.reviewsGenerated = (existing.reviewsGenerated || 0) + (loc.reviewsGenerated || 0);
      existing.reviewsRespondedTo = (existing.reviewsRespondedTo || 0) + (loc.reviewsRespondedTo || 0);
      existing.postsQaCount = (existing.postsQaCount || 0) + (loc.postsQaCount || 0);
      if (loc.leadQuality && existing.leadQuality) {
        existing.leadQuality.good = (existing.leadQuality.good || 0) + (loc.leadQuality.good || 0);
        existing.leadQuality.notQuotable = (existing.leadQuality.notQuotable || 0) + (loc.leadQuality.notQuotable || 0);
        existing.leadQuality.missedCalls = (existing.leadQuality.missedCalls || 0) + (loc.leadQuality.missedCalls || 0);
        existing.leadQuality.noData = (existing.leadQuality.noData || 0) + (loc.leadQuality.noData || 0);
      }
    } else {
      deduped.push({ ...loc });
    }
  }
  return deduped;
}

function importedMetrics(imp: GbpLocationLite) {
  return {
    uniqueLeads: imp.uniqueLeads ?? 0,
    reviewsGenerated: imp.reviewsGenerated ?? 0,
    reviewsRespondedTo: imp.reviewsRespondedTo ?? 0,
    postsQaCount: imp.postsQaCount ?? 0,
    leadQuality: {
      good: imp.leadQuality?.good ?? 0,
      notQuotable: imp.leadQuality?.notQuotable ?? 0,
      missedCalls: imp.leadQuality?.missedCalls ?? 0,
      noData: imp.leadQuality?.noData ?? 0,
    },
  };
}

/**
 * Merge a batch of locations parsed from a PDF into the existing report's
 * marketing.gbp.locations array, preferring stable identity over fresh UUIDs
 * and REFUSING to invent confident rows for foreign / unresolved names.
 *
 * For each imported row, in order:
 *   a. If it resolves (exact or parenthetical "(City)") to a row already in
 *      `existingReportLocations`, update that row's numeric fields and
 *      leadQuality in place; keep the existing id, name, and heatmap fields.
 *   b. Else if it resolves to a `commandPanelLocations` entry, append a new row
 *      using that command-panel id and name.
 *   c. Else it is UNRESOLVED — it is NOT appended to `merged`; instead it is
 *      collected in `unresolved` for the operator to review. (Previously this
 *      branch silently appended a `crypto.randomUUID()` row, which is exactly
 *      how foreign locations entered reports.)
 *
 * The imported batch is first run through `deduplicateGbpLocations` so two
 * imported rows with the same name collapse before merging.
 *
 * `newId` is retained for signature stability / future use but is no longer
 * called for unresolved rows.
 */
export function mergeImportedGbpLocations(
  existingReportLocations: GbpLocationLite[],
  importedRows: GbpLocationLite[],
  commandPanelLocations: CommandPanelLocationLite[],
  _newId: () => string = () => crypto.randomUUID(),
): MergeImportedResult {
  const dedupedImports = deduplicateGbpLocations(importedRows);
  const merged: GbpLocationLite[] = existingReportLocations.map(loc => ({ ...loc }));
  const unresolved: GbpLocationLite[] = [];

  for (const imp of dedupedImports) {
    if (!normalizeGbpLocationName(imp.name || '')) continue;

    const existingIdx = merged.findIndex(loc => gbpNameMatches(imp.name || '', loc.name || ''));
    if (existingIdx >= 0) {
      merged[existingIdx] = { ...merged[existingIdx], ...importedMetrics(imp) };
      continue;
    }

    const cp = matchCommandPanelLocation(imp.name || '', commandPanelLocations);
    if (cp) {
      merged.push({ id: cp.id, name: cp.name, ...importedMetrics(imp) });
      continue;
    }

    unresolved.push({ ...imp, ...importedMetrics(imp) });
  }

  return { merged, unresolved };
}
