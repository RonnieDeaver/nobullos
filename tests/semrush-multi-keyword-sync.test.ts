/* test-registration
{
  "name": "SEMrush multi-keyword sync",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for the SEMrush multi-keyword sync fix (task #667).
 *
 * Pins the fact that when a campaign has multiple distinct keywords, every
 * keyword's heatmap is fetched and persisted for the current report date —
 * not just the first one. The previous bug only saved the first keyword's
 * snapshot under partial-coverage situations.
 *
 * The test seeds a single client + location + campaign, advertises three
 * distinct keywords, runs `syncCampaignForClient`, and asserts:
 *   1. SEMrush getHeatmapData was called exactly three times (once per kw).
 *   2. Three heatmap snapshots exist for that (client, location, campaign,
 *      reportDate) tuple after the sync.
 *   3. Result status === "success" with imported === 3.
 */

import { db } from "../server/db";
import {
  clients,
  clientLocations,
  heatmapSnapshots,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  syncCampaignForClient,
  __setSemrushSyncTestOverrides,
} from "../server/services/localDominanceSyncWorker";
import type { SemrushHeatmapPoint } from "../server/services/semrushApi";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `smkw-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REPORT_DATE_ISO = "2026-04-15T12:00:00.000Z";

const KEYWORDS = [
  { id: "kw1", name: `kw1 ${TAG} estate planning attorney` },
  { id: "kw2", name: `kw2 ${TAG} probate lawyer` },
  { id: "kw3", name: `kw3 ${TAG} elder law` },
];

const createdClientIds: string[] = [];
const createdLocationIds: string[] = [];

async function seed(): Promise<{ clientId: string; locationId: string; campaignId: string }> {
  const [c] = await db.insert(clients).values({ firmName: `Multi-keyword ${TAG}` })
    .returning({ id: clients.id });
  createdClientIds.push(c.id);
  const [l] = await db.insert(clientLocations).values({ clientId: c.id, name: "L1" })
    .returning({ id: clientLocations.id });
  createdLocationIds.push(l.id);
  return { clientId: c.id, locationId: l.id, campaignId: `camp-${TAG}` };
}

async function cleanup(): Promise<void> {
  if (createdClientIds.length) {
    await db.delete(heatmapSnapshots).where(inArray(heatmapSnapshots.clientId, createdClientIds));
    await db.delete(clientLocations).where(inArray(clientLocations.id, createdLocationIds));
    await db.delete(clients).where(inArray(clients.id, createdClientIds));
  }
}

async function main(): Promise<void> {
  const { clientId, locationId, campaignId } = await seed();

  const heatmapCalls: Array<{ campaignId: string; keywordId: string }> = [];
  __setSemrushSyncTestOverrides({
    semrushApi: {
      getCampaign: async (cid: string) => ({
        id: cid,
        reportDates: [REPORT_DATE_ISO],
        businessName: "MK Business",
        gridSettings: { template: "9x9", unit: "MILES", distance: 5, basePoint: { lat: 40, lng: -75 } },
        lat: 40,
        lng: -75,
      }),
      getCampaignKeywordsWithMeta: async () => ({
        keywords: KEYWORDS.map(k => ({ id: k.id, name: k.name, status: "ACTIVE" })),
        complete: true,
      }),
      findBestReportDate: (dates: string[]) => dates[0] ?? null,
      getHeatmapData: async (cid: string, kid: string) => {
        heatmapCalls.push({ campaignId: cid, keywordId: kid });
        const kw = KEYWORDS.find(k => k.id === kid)!;
        const positions: SemrushHeatmapPoint[] = [
          { point: { id: "p1", lat: 40, lng: -75 }, rank: 1, diff: 0 },
        ];
        return {
          keyword: { id: kw.id, name: kw.name },
          date: REPORT_DATE_ISO,
          positions,
        };
      },
    },
  });

  try {
    const result = await syncCampaignForClient(clientId, campaignId, locationId, "MK Business");
    assert(result.status === "success", `expected status=success, got ${result.status}`);
    assert(result.imported === 3, `expected imported=3, got ${result.imported}`);
    assert(heatmapCalls.length === 3,
      `expected 3 SEMrush heatmap fetches (one per keyword), got ${heatmapCalls.length}`);

    const fetchedKeywordIds = new Set(heatmapCalls.map(c => c.keywordId));
    for (const k of KEYWORDS) {
      assert(fetchedKeywordIds.has(k.id),
        `expected keyword ${k.id} to be fetched, calls=${JSON.stringify(heatmapCalls)}`);
    }

    // Verify all three snapshots are persisted for the current report date.
    const snaps = await db.select({
      keywordName: heatmapSnapshots.keywordName,
    })
      .from(heatmapSnapshots)
      .where(and(
        eq(heatmapSnapshots.clientId, clientId),
        eq(heatmapSnapshots.locationId, locationId),
        eq(heatmapSnapshots.campaignId, campaignId),
        eq(heatmapSnapshots.reportDate, new Date(REPORT_DATE_ISO)),
      ));
    assert(snaps.length === 3,
      `expected 3 persisted snapshots for the report date, got ${snaps.length} (${JSON.stringify(snaps.map(s => s.keywordName))})`);
    const persistedNames = new Set(snaps.map(s => s.keywordName));
    for (const k of KEYWORDS) {
      assert(persistedNames.has(k.name),
        `expected keyword ${k.name} to be persisted, got ${JSON.stringify(Array.from(persistedNames))}`);
    }
    console.log("semrush-multi-keyword-sync: PASSED");
  } finally {
    __setSemrushSyncTestOverrides(null);
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("semrush-multi-keyword-sync: FAILED", err);
  __setSemrushSyncTestOverrides(null);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
