/* test-registration
{
  "name": "Heatmap search returns client name + null fallback (Task #2892)",
  "regression": true,
  "sweepOnlyReason": "Task #2892 — DB-backed searchSnapshots join: clientName returned for linked snapshots and null for unlinked; client-name search predicate. Real DB writes (seed+cleanup), not a smoke-gate candidate.",
  "tier": "small"
}
test-registration */
/**
 * Task #2892 — heatmap search returns client name.
 *
 * Three invariants are pinned:
 *   1. A snapshot linked to a client carries that client's firmName as
 *      `clientName` in the searchSnapshots result.
 *   2. A snapshot with no client_id returns `clientName: null` — the
 *      null-client fallback is explicit, never omitted.
 *   3. Searching by client name finds the linked snapshot and does NOT
 *      return the unlinked one.
 *
 * DB-backed; seeds isolated tagged rows and deletes them in a finally block.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import { searchSnapshots } from "../server/services/heatmapService";

const TAG = "task-2892-heatmap-search-client";

const clientId = `${TAG}-${randomUUID().slice(0, 8)}`;
const snapLinkedId = randomUUID();
const snapUnlinkedId = randomUUID();
const FIRM_NAME = `${TAG}-FirmABC`;

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${clientId}, ${FIRM_NAME})
    ON CONFLICT (id) DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO heatmap_snapshots
      (id, client_id, campaign_id, keyword_name, report_date,
       location_id, location_name,
       business_lat, business_lng,
       grid_template, grid_unit, grid_distance,
       base_lat, base_lng, raw_payload)
    VALUES
      (${snapLinkedId}, ${clientId}, ${`${TAG}-camp`}, 'personal injury', ${new Date().toISOString().slice(0, 10)},
       ${`${TAG}-loc-linked`}, ${`${TAG}-Chicago`},
       41.8, -87.6, '7x7', 'MILES', 3, 41.8, -87.6, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO heatmap_snapshots
      (id, client_id, campaign_id, keyword_name, report_date,
       location_id, location_name,
       business_lat, business_lng,
       grid_template, grid_unit, grid_distance,
       base_lat, base_lng, raw_payload)
    VALUES
      (${snapUnlinkedId}, NULL, ${`${TAG}-camp-unlinked`}, 'car accident', ${new Date().toISOString().slice(0, 10)},
       ${`${TAG}-loc-unlinked`}, ${`${TAG}-Dallas`},
       32.7, -96.7, '9x9', 'MILES', 5, 32.7, -96.7, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM heatmap_snapshots WHERE id IN (${snapLinkedId}, ${snapUnlinkedId})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  } catch {}
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

async function main(): Promise<void> {
  await seed();
  try {
    await step("linked snapshot carries firmName as clientName", async () => {
      const results = await searchSnapshots({ search: TAG, limit: 100 });
      const linked = results.find((r) => r.id === snapLinkedId);
      assert.ok(linked, "linked snapshot must be present in search results");
      assert.equal(linked.clientName, FIRM_NAME, "clientName must equal the client's firmName");
    });

    await step("unlinked snapshot returns clientName: null", async () => {
      const results = await searchSnapshots({ search: TAG, limit: 100 });
      const unlinked = results.find((r) => r.id === snapUnlinkedId);
      assert.ok(unlinked, "unlinked snapshot must be present in search results");
      assert.equal(unlinked.clientName, null, "clientName must be null when no client is linked");
    });

    await step("searching by client name returns linked snapshot, not unlinked", async () => {
      const results = await searchSnapshots({ search: FIRM_NAME, limit: 100 });
      const linkedFound = results.some((r) => r.id === snapLinkedId);
      const unlinkedFound = results.some((r) => r.id === snapUnlinkedId);
      assert.equal(linkedFound, true, "client-name search must find the linked snapshot");
      assert.equal(unlinkedFound, false, "client-name search must not return the unlinked snapshot");
    });

    await step("all results include clientName key (not undefined) regardless of link", async () => {
      const results = await searchSnapshots({ search: TAG, limit: 100 });
      for (const r of results.filter((x) => x.id === snapLinkedId || x.id === snapUnlinkedId)) {
        assert.ok("clientName" in r, `snapshot ${r.id} must expose clientName key`);
      }
    });
  } finally {
    await cleanup();
  }

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nheatmap-search-client-name: all assertions passed");
}

main().catch((err) => {
  console.error("Test runner failed:", err?.message ?? err);
  process.exitCode = 1;
});
