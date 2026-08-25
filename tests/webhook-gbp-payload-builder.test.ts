/* test-registration
{
  "name": "Webhook GBP payload builder resolve/skip (Task #2595)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2595 — server-side counterpart to
 * tests/import-gbp-location-matching.test.ts.
 *
 * That existing test only covers the CLIENT merge helper
 * (mergeImportedGbpLocations). This one covers the SERVER webhook
 * (`system:pdf-webhook`) payload builder extracted from
 * server/routes/reports.ts into server/services/webhookGbpPayload.ts.
 *
 * Shared responsibility being guarded (Task #2568): resolve each parsed PDF
 * location against the client's Command Panel via the shared
 * `matchCommandPanelLocation` matcher; EXCLUDE unresolved (foreign / unknown)
 * names from the persisted `gbp.locations`; collect them as `unresolved` so
 * the route stores them under `marketing.gbpUnresolvedImports` for the
 * operator. A foreign-source PDF must NEVER mint a confident GBP row on the
 * wrong client (the Lansing / Waverly on a Lehi / Las Vegas client bug).
 *
 * The local-dominance fetcher is injected so this test never touches the DB
 * or network.
 */

import { buildWebhookGbpLocationsPayload } from "../server/services/webhookGbpPayload";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}

// Identity dedupe by default keeps the matcher behavior the focus; one test
// below exercises a real dedupe function to mirror the route's deduplicateLocations.
const noFetch = async () => new Map<string, any>();

async function main() {
  console.log("buildWebhookGbpLocationsPayload");

  await run(
    "foreign-city import (Lansing/Waverly on a Lehi/Las Vegas client) is unresolved, never persisted",
    async () => {
      // The exact failure that produced the bad Trusted Estate report: a PDF
      // from the wrong source carried cities belonging to no command-panel
      // location. They must be excluded from gbp.locations and surfaced as
      // unresolved — never minted as confident rows.
      const configured = [
        { id: "cp-lehi", name: "Trusted Estate Planning Attorneys (Lehi)" },
        { id: "cp-lv", name: "Trusted Estate Planning Attorneys (Las Vegas)" },
      ];
      const parsed = [
        { name: "Lehi", uniqueLeads: 10, reviewsGenerated: 3 },
        { name: "Lansing", uniqueLeads: 12, reviewsGenerated: 1 },
        { name: "Waverly", uniqueLeads: 8 },
      ];
      const { locations, unresolved } = await buildWebhookGbpLocationsPayload(
        parsed,
        configured,
        {},
        { fetchDominance: noFetch },
      );

      // Only the resolvable "Lehi" is persisted, and it uses the command-panel id.
      assert(locations.length === 1, `expected 1 persisted location, got ${locations.length}`);
      assert(locations[0].id === "cp-lehi", `resolved row should use command-panel id, got ${locations[0].id}`);
      assert(locations[0].name === "Lehi", `resolved row keeps parsed name, got ${locations[0].name}`);
      assert(locations[0].uniqueLeads === 10, `metrics from parsed row, got ${locations[0].uniqueLeads}`);

      // The foreign cities are NOT in the persisted payload...
      assert(
        !locations.some((l) => l.name === "Lansing" || l.name === "Waverly"),
        "foreign cities must NOT appear in persisted gbp.locations",
      );
      // ...and they ARE surfaced as unresolved for marketing.gbpUnresolvedImports.
      const names = unresolved.map((u) => u.name).sort();
      assert(unresolved.length === 2, `expected 2 unresolved, got ${unresolved.length}`);
      assert(names[0] === "Lansing" && names[1] === "Waverly", `unresolved should be Lansing + Waverly, got ${names.join(",")}`);
      // Unresolved entries preserve their metrics (no data loss before operator review).
      const lansing = unresolved.find((u) => u.name === "Lansing")!;
      assert(lansing.uniqueLeads === 12 && lansing.reviewsGenerated === 1, "unresolved preserves parsed metrics");
    },
  );

  await run("resolves a short PDF city name to a parenthetical command-panel name", async () => {
    const configured = [{ id: "cp-alex", name: "Speedwell Law, PLLC (Alexandria)" }];
    const parsed = [{ name: "Alexandria", uniqueLeads: 5 }];
    const { locations, unresolved } = await buildWebhookGbpLocationsPayload(
      parsed,
      configured,
      {},
      { fetchDominance: noFetch },
    );
    assert(locations.length === 1, `expected 1 persisted, got ${locations.length}`);
    assert(unresolved.length === 0, `expected nothing unresolved, got ${unresolved.length}`);
    assert(locations[0].id === "cp-alex", `should use command-panel id, got ${locations[0].id}`);
    assert(locations[0].uniqueLeads === 5, "metrics from parsed row");
  });

  await run("attaches heatmap snapshot ids for a resolved location", async () => {
    const configured = [{ id: "cp-1", name: "Adolphe Law Group Fort Pierce" }];
    const parsed = [{ name: "adolphe law group fort pierce", uniqueLeads: 3 }];
    const heatmap = { "cp-1": ["snap-a", "snap-b"] };
    const { locations } = await buildWebhookGbpLocationsPayload(
      parsed,
      configured,
      heatmap,
      { fetchDominance: noFetch },
    );
    assert(locations.length === 1, `expected 1 persisted, got ${locations.length}`);
    assert(locations[0].id === "cp-1", "uses command-panel id");
    assert(locations[0].heatmapSnapshotId === "snap-a", "heatmapSnapshotId is first snapshot");
    assert(
      Array.isArray(locations[0].heatmapSnapshotIds) && locations[0].heatmapSnapshotIds.length === 2,
      "heatmapSnapshotIds carries all snapshots",
    );
  });

  await run("injected dominance enrichment is attached to the matching resolved row", async () => {
    const configured = [{ id: "cp-1", name: "Real Place" }];
    const parsed = [{ name: "Real Place", uniqueLeads: 2 }];
    const heatmap = { "cp-1": ["snap-x"] };
    let receivedClientId = "";
    let receivedBulk: any[] = [];
    const fetchDominance = async (clientId: string, bulk: any[]) => {
      receivedClientId = clientId;
      receivedBulk = bulk;
      return new Map<string, any>([["cp-1", { rank: 1 }]]);
    };
    const { locations } = await buildWebhookGbpLocationsPayload(
      parsed,
      configured,
      heatmap,
      { fetchDominance, clientId: "client-42" },
    );
    assert(receivedClientId === "client-42", `clientId threaded to fetcher, got ${receivedClientId}`);
    assert(receivedBulk.length === 1 && receivedBulk[0].locationId === "cp-1", "only snapshot-bearing rows are bulk-enriched");
    assert(locations[0].localDominance && locations[0].localDominance.rank === 1, "dominance attached to resolved row");
  });

  await run("a throwing dominance fetcher degrades gracefully (rows still persisted, no enrichment)", async () => {
    const configured = [{ id: "cp-1", name: "Real Place" }];
    const parsed = [{ name: "Real Place", uniqueLeads: 2 }];
    const heatmap = { "cp-1": ["snap-x"] };
    const fetchDominance = async () => {
      throw new Error("dominance service down");
    };
    const { locations } = await buildWebhookGbpLocationsPayload(
      parsed,
      configured,
      heatmap,
      { fetchDominance },
    );
    assert(locations.length === 1, "row still persisted despite dominance failure");
    assert(locations[0].localDominance === undefined, "no localDominance key when fetch throws");
  });

  await run("uses the injected dedupe (mirrors route's deduplicateLocations) and sums metrics", async () => {
    const configured = [{ id: "cp-lw", name: "Lake Worth" }];
    const parsed = [
      { name: "Lake Worth", uniqueLeads: 4 },
      { name: "lake worth", uniqueLeads: 6 },
    ];
    // Minimal dedupe collapsing case-insensitive equal names, summing leads —
    // enough to prove the helper honors the injected dedupe before resolving.
    const deduplicate = (locs: any[]) => {
      const out: any[] = [];
      for (const loc of locs) {
        const hit = out.find((d) => (d.name || "").toLowerCase() === (loc.name || "").toLowerCase());
        if (hit) hit.uniqueLeads = (hit.uniqueLeads || 0) + (loc.uniqueLeads || 0);
        else out.push({ ...loc });
      }
      return out;
    };
    const { locations, unresolved } = await buildWebhookGbpLocationsPayload(
      parsed,
      configured,
      {},
      { deduplicate, fetchDominance: noFetch },
    );
    assert(locations.length === 1, `expected dedupe to collapse to 1, got ${locations.length}`);
    assert(unresolved.length === 0, `expected nothing unresolved, got ${unresolved.length}`);
    assert(locations[0].uniqueLeads === 10, `expected summed metrics 10, got ${locations[0].uniqueLeads}`);
  });

  await run("empty parsed input yields empty payload and no unresolved", async () => {
    const { locations, unresolved } = await buildWebhookGbpLocationsPayload(
      [],
      [{ id: "cp-1", name: "Anywhere" }],
      {},
      { fetchDominance: noFetch },
    );
    assert(locations.length === 0 && unresolved.length === 0, "empty in, empty out");
  });

  console.log("\nAll webhook-gbp-payload-builder assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
