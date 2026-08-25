/**
 * Pure, testable payload builder for the webhook PDF-import GBP locations
 * (the `system:pdf-webhook` path in `server/routes/reports.ts`).
 *
 * This is the SERVER-side counterpart to the client merge helper
 * `client/src/lib/gbpLocationMerge.ts` (covered by
 * `tests/import-gbp-location-matching.test.ts`). Both resolve parsed PDF
 * location names against the client's real Command Panel locations through the
 * ONE shared parenthetical-aware matcher in `shared/gbpLocationMatch.ts`.
 *
 * Task #2568 — a parsed location that does NOT resolve to a Command Panel
 * location is collected as `unresolved` (surfaced to the operator and stored
 * on `marketing.gbpUnresolvedImports`) instead of being silently minted as a
 * confident `crypto.randomUUID()` GBP row. That naive
 * exact-match-or-fresh-UUID behavior is how a foreign source PDF's cities
 * (e.g. Lansing / Waverly) became published GBP rows on a Lehi / Las Vegas
 * client.
 *
 * Extracting the block out of the route handler keeps it assertable without a
 * full HTTP round-trip (Task #2595). The local-dominance enrichment is
 * injectable so the test never touches the DB / network; in production it
 * defaults to the real bulk service.
 */

import { matchCommandPanelLocation, type GbpMatchCandidate } from "@shared/gbpLocationMatch";

export interface WebhookGbpUnresolved {
  name: string;
  uniqueLeads: number;
  reviewsGenerated: number;
}

export interface BuildWebhookGbpOptions {
  /** Dedupe parsed rows before resolution. Defaults to identity (no dedupe). */
  deduplicate?: (locations: any[]) => any[];
  /** Client id passed through to the dominance fetcher. */
  clientId?: string;
  /**
   * Bulk local-dominance fetcher. Injectable for tests; defaults to the real
   * `localDominanceService`. A throw here is swallowed (best-effort enrichment)
   * exactly as the original inline block did.
   */
  fetchDominance?: (
    clientId: string,
    bulkInput: Array<{ locationId: string; snapshotIds: string[] }>,
  ) => Promise<Map<string, any>>;
}

export interface WebhookGbpPayloadResult {
  /** Resolved GBP rows to persist under `marketing.gbp.locations`. */
  locations: any[];
  /** Parsed rows that did NOT resolve — surfaced, never minted as rows. */
  unresolved: WebhookGbpUnresolved[];
}

/**
 * Resolve parsed GBP locations against the client's configured Command Panel
 * locations, returning the rows to persist plus the unresolved (foreign /
 * unknown) rows. Unresolved rows are NEVER given a fresh id and NEVER appear
 * in `locations`.
 */
export async function buildWebhookGbpLocationsPayload(
  rawGbpLocations: any[],
  configuredLocations: GbpMatchCandidate[],
  heatmapMapping: Record<string, string[]>,
  options: BuildWebhookGbpOptions = {},
): Promise<WebhookGbpPayloadResult> {
  const dedupe = options.deduplicate ?? ((l: any[]) => l);
  const dedupedLocs = dedupe(rawGbpLocations || []);
  const unresolved: WebhookGbpUnresolved[] = [];

  const prepared = dedupedLocs
    .map((loc: any) => {
      const locName = loc.name || '';
      const matchedConfigured = matchCommandPanelLocation(locName, configuredLocations);
      if (!matchedConfigured) {
        unresolved.push({
          name: locName,
          uniqueLeads: loc.uniqueLeads || 0,
          reviewsGenerated: loc.reviewsGenerated || 0,
        });
        return null;
      }
      const locId = matchedConfigured.id;
      const snapshotIds = heatmapMapping[locId] || [];
      return { loc, locName, locId, snapshotIds };
    })
    .filter((p): p is { loc: any; locName: string; locId: string; snapshotIds: string[] } => p !== null);

  let dominanceMap = new Map<string, any>();
  const bulkInput = prepared
    .filter((p) => p.snapshotIds.length > 0)
    .map((p) => ({ locationId: p.locId, snapshotIds: p.snapshotIds }));
  if (bulkInput.length > 0) {
    try {
      const fetchDominance =
        options.fetchDominance ??
        (async (clientId: string, input: Array<{ locationId: string; snapshotIds: string[] }>) => {
          const { getLocalDominanceDataForReportBulk } = await import("./localDominanceService");
          return getLocalDominanceDataForReportBulk(clientId, input);
        });
      dominanceMap = await fetchDominance(options.clientId || '', bulkInput);
    } catch (e: any) {
      console.warn(`[Webhook] Failed to bulk-enrich local dominance:`, e?.message);
    }
  }

  const locations = prepared.map(({ loc, locName, locId, snapshotIds }) => {
    const localDominanceData = dominanceMap.get(locId) ?? null;
    return {
      id: locId,
      name: locName,
      uniqueLeads: loc.uniqueLeads || 0,
      reviewsGenerated: loc.reviewsGenerated || 0,
      reviewsRespondedTo: loc.reviewsRespondedTo || 0,
      postsQaCount: loc.postsQaCount || 0,
      leadQuality: loc.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      ...(snapshotIds.length > 0 ? { heatmapSnapshotIds: snapshotIds, heatmapSnapshotId: snapshotIds[0] } : {}),
      ...(localDominanceData ? { localDominance: localDominanceData } : {}),
    };
  });

  return { locations, unresolved };
}
