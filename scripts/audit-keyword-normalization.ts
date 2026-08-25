/**
 * Read-only audit: which heatmap_snapshots rows are stored under a
 * keywordName whose canonical normalized form differs from the raw column?
 *
 * After this audit lands, the write path inserts via the canonical
 * `normalizeKeyword` matcher, but pre-existing rows may still be stored as
 * "Plumber" / "  plumber  ". This script reports them so an operator can
 * decide whether to leave them be or run a one-off normalization update.
 *
 * Usage:
 *   npx tsx scripts/audit-keyword-normalization.ts            # summary only
 *   npx tsx scripts/audit-keyword-normalization.ts --detail   # list samples
 */
import { workerDb as db } from "../server/db";
import { heatmapSnapshots } from "@shared/schema";
import { sql } from "drizzle-orm";
import { normalizeKeyword } from "../shared/keywordNormalization";

async function main() {
  const detail = process.argv.includes("--detail");

  // Pull every distinct (campaignId, locationId, keywordName) tuple. This is
  // bounded by the cardinality of the keyword inventory, not the row count
  // of heatmap_snapshots, so it's safe to read in one pass.
  const rows = await db
    .select({
      campaignId: heatmapSnapshots.campaignId,
      locationId: heatmapSnapshots.locationId,
      keywordName: heatmapSnapshots.keywordName,
      n: sql<number>`count(*)::int`,
    })
    .from(heatmapSnapshots)
    .groupBy(heatmapSnapshots.campaignId, heatmapSnapshots.locationId, heatmapSnapshots.keywordName);

  let nonCanonicalRows = 0;
  let nonCanonicalSnapshots = 0;
  // Group by (campaignId, locationId, normalize(keywordName)) and surface
  // any group with >1 distinct raw spelling — those are the duplicates the
  // pre-fix dedup lookup couldn't see.
  const groups = new Map<string, Array<{ raw: string; n: number }>>();
  for (const r of rows) {
    const norm = normalizeKeyword(r.keywordName);
    const key = `${r.campaignId}::${r.locationId}::${norm}`;
    const list = groups.get(key) ?? [];
    list.push({ raw: r.keywordName, n: r.n });
    groups.set(key, list);
    if (r.keywordName !== norm) {
      nonCanonicalRows++;
      nonCanonicalSnapshots += r.n;
    }
  }

  const dupeGroups = Array.from(groups.entries()).filter(([, list]) => list.length > 1);

  console.log(`Total distinct (campaign, location, keyword) tuples: ${rows.length}`);
  console.log(`Tuples whose raw keywordName != normalize(keywordName): ${nonCanonicalRows}`);
  console.log(`Snapshot rows under non-canonical keyword names: ${nonCanonicalSnapshots}`);
  console.log(`Duplicate groups (same canonical keyword, multiple raw spellings): ${dupeGroups.length}`);

  if (detail) {
    console.log("\nSample duplicate groups (up to 25):");
    for (const [k, list] of dupeGroups.slice(0, 25)) {
      console.log(`  ${k}`);
      for (const v of list) console.log(`    - "${v.raw}" (${v.n} snapshot${v.n === 1 ? "" : "s"})`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
