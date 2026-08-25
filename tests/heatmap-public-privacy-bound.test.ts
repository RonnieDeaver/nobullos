/* test-registration
{
  "name": "Public heatmap endpoints mask snapshots bound to privacy-mode reports (Task #4290)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4290: the public heatmap meta/geojson endpoints are the SECOND privacy leak channel — they are unauthenticated and payload-level masking cannot reach them, so a privacy share's map would fetch real location/keyword/business names from the browser. This is the only tripwire on the fail-closed privacy-bound check; a regression re-identifies clients on every privacy share. Fast route test, hermetic DB.",
  "tier": "small"
}
test-registration */
/**
 * Task #4290 — the public heatmap endpoints (`/api/public/heatmaps/:id/meta`
 * and `/geojson`) are unauthenticated by design (shared reports fetch them
 * from the browser), so the payload-level privacy masker cannot protect
 * them: a privacy share's map would still fetch the REAL location name,
 * keyword phrase and business pin label straight from these routes.
 *
 * Pins, against the real routes (registerHeatmapRoutes + hermetic DB):
 *   1. A snapshot referenced from a privacy-mode report's marketing section
 *      serves MASKED meta (locationName/businessName/keywordName/locationId/
 *      campaignId/keywordId/clientId all null) and a geojson whose business
 *      pin is labeled "Confidential Client" — while grid geometry, cell
 *      colors and coordinates survive (the map must still render).
 *   2. A snapshot NOT referenced by any privacy report serves real values —
 *      normal shares are unchanged.
 *   3. Flipping the report's privacy_mode off (+ cache reset — the binding
 *      check holds a 60s TTL cache) restores real values: the binding is
 *      derived live, not sticky.
 */

import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerHeatmapRoutes } from "../server/routes/heatmap";
import { __resetSnapshotPrivacyCacheForTest } from "../server/services/reportPrivacyMasking";

// Ensure the Clerk per-request test seam is active for bare repros too.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const SUF = `t4290h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const CLIENT_ID = `${SUF}-client`;
const REPORT_ID = `${SUF}-report`;
const SNAP_BOUND = randomUUID();
const SNAP_FREE = randomUUID();

const LOC_NAME = `Rivergate${SUF} North Office`;
const BIZ_NAME = `Blackstone${SUF} Injury Law`;
// heatmap_snapshots_keyword_name_canonical_chk: lowercase, single-spaced, trimmed.
const KW_NAME = `rivergate${SUF} car accident lawyer`;

let passed = 0;
let failed = 0;

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM heatmap_snapshots WHERE id IN (${SNAP_BOUND}, ${SNAP_FREE})`).catch(() => 0);
  await db.execute(sql`DELETE FROM report_sections WHERE report_id = ${REPORT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM reports WHERE id = ${REPORT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`).catch(() => 0);
}

/**
 * Cache-shaped GeoJSON the service serves verbatim: geometryVersion 2 (the
 * current GEOJSON_GEOMETRY_VERSION) and every cell carrying `position` means
 * recolorCachedGeoJSON re-derives colors in place and returns the cache —
 * no heatmap_points seeding needed.
 */
function geojsonCacheFor(name: string): Record<string, unknown> {
  return {
    type: "FeatureCollection",
    geometryVersion: 2,
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[-97.1, 32.9], [-97.0, 32.9], [-97.0, 33.0], [-97.1, 33.0], [-97.1, 32.9]]] },
        properties: { type: "cell", pointId: "p1", lat: 32.95, lng: -97.05, position: 5, diff: 1 },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-97.05, 32.95] },
        properties: { type: "business", name, lat: 32.95, lng: -97.05 },
      },
    ],
  };
}

async function seedSnapshot(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO heatmap_snapshots
      (id, client_id, location_id, location_name, business_name, campaign_id,
       keyword_name, report_date, business_lat, business_lng, grid_template,
       grid_unit, grid_distance, base_lat, base_lng, raw_payload, geojson_cache)
    VALUES
      (${id}, NULL, ${`loc-${SUF}`}, ${LOC_NAME}, ${BIZ_NAME}, ${`camp-${SUF}`},
       ${KW_NAME}, NOW(), 32.95, -97.05, '7x7',
       'MILES', 1, 32.95, -97.05, '{}'::jsonb, ${JSON.stringify(geojsonCacheFor(BIZ_NAME))}::jsonb)
  `);
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, contact_name)
    VALUES (${CLIENT_ID}, ${BIZ_NAME}, 'Task4290h')
  `);
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, privacy_mode)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, '2026-07', 'final', true)
  `);
  // SNAP_BOUND appears inside the privacy report's marketing section — the
  // exact binding shape the serve path stores (heatmapSnapshotIds array).
  await db.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES (${REPORT_ID}, 'marketing', ${JSON.stringify({
      gbp: { locations: [{ name: LOC_NAME, heatmapSnapshotIds: [SNAP_BOUND] }] },
    })}::jsonb)
  `);
  await seedSnapshot(SNAP_BOUND);
  await seedSnapshot(SNAP_FREE);
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function run(): Promise<void> {
  await cleanup();
  await seed();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): null is
    // explicit-anonymous. All assertions here hit the unauthenticated public
    // heatmap endpoints, so the caller is always anonymous.
    (req as any).__test_clerkUserId = null;
    next();
  });
  registerHeatmapRoutes(app);
  const { server, baseUrl } = await listen(app);

  const getJson = async (path: string): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${baseUrl}${path}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const pinOf = (geojson: any): any =>
    (geojson?.features ?? []).find((f: any) => f?.properties?.type === "business");

  try {
    // 1. Privacy-bound snapshot → masked meta + masked pin.
    {
      const meta = await getJson(`/api/public/heatmaps/${SNAP_BOUND}/meta`);
      ok(meta.status === 200, `bound meta → 200 (got ${meta.status})`);
      const snap = meta.body?.snapshot ?? {};
      ok(snap.locationName === null, `bound meta locationName masked (got ${JSON.stringify(snap.locationName)})`);
      ok(snap.businessName === null, `bound meta businessName masked (got ${JSON.stringify(snap.businessName)})`);
      ok(snap.keywordName === null, `bound meta keywordName masked (got ${JSON.stringify(snap.keywordName)})`);
      ok(snap.locationId === null && snap.campaignId === null, "bound meta vendor reference ids masked");
      ok(snap.clientId === null, "bound meta clientId masked");
      ok(typeof snap.businessLat === "number" && typeof snap.gridDistance === "number", "bound meta keeps geometry (businessLat/gridDistance)");
      ok(snap.id === SNAP_BOUND, "bound meta keeps snapshot id");

      const geo = await getJson(`/api/public/heatmaps/${SNAP_BOUND}/geojson`);
      ok(geo.status === 200, `bound geojson → 200 (got ${geo.status})`);
      const pin = pinOf(geo.body);
      ok(pin?.properties?.name === "Confidential Client", `bound pin → "Confidential Client" (got ${JSON.stringify(pin?.properties?.name)})`);
      const cell = (geo.body?.features ?? []).find((f: any) => f?.properties?.type !== "business");
      ok(cell?.properties?.position === 5 && typeof cell?.properties?.color === "string", "bound geojson cells keep position + recolored color");
      ok(!JSON.stringify(geo.body).includes(BIZ_NAME), "bound geojson contains no business name anywhere");
    }

    // 2. Unbound snapshot → untouched (normal shares unchanged).
    {
      const meta = await getJson(`/api/public/heatmaps/${SNAP_FREE}/meta`);
      ok(meta.status === 200, `free meta → 200 (got ${meta.status})`);
      const snap = meta.body?.snapshot ?? {};
      ok(snap.locationName === LOC_NAME, `free meta serves real locationName (got ${JSON.stringify(snap.locationName)})`);
      ok(snap.keywordName === KW_NAME, "free meta serves real keywordName");
      ok(snap.businessName === BIZ_NAME, "free meta serves real businessName");

      const geo = await getJson(`/api/public/heatmaps/${SNAP_FREE}/geojson`);
      ok(pinOf(geo.body)?.properties?.name === BIZ_NAME, "free pin keeps the real business name");
    }

    // 3. Privacy flag off + cache reset → the bound snapshot serves real
    //    values again (binding is derived live; the 60s TTL cache is the only
    //    staleness, and it has a test reset seam).
    {
      await db.execute(sql`UPDATE reports SET privacy_mode = false WHERE id = ${REPORT_ID}`);
      __resetSnapshotPrivacyCacheForTest();
      const meta = await getJson(`/api/public/heatmaps/${SNAP_BOUND}/meta`);
      ok(meta.body?.snapshot?.locationName === LOC_NAME, "after privacy off + cache reset: real locationName again");
      const geo = await getJson(`/api/public/heatmaps/${SNAP_BOUND}/geojson`);
      ok(pinOf(geo.body)?.properties?.name === BIZ_NAME, "after privacy off + cache reset: real pin label again");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {
      // best-effort
    }
  }

  await cleanup();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

run().then(
  () => {},
  async (err) => {
    console.error("Test threw:", err);
    await cleanup().catch(() => 0);
    process.exitCode = 1;
  },
);
