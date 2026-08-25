/* test-registration
{
  "name": "SEMrush auto-match autoSave persistence (Task #2260)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2260 — persistence coverage for the SEMrush auto-match endpoint.
 *
 * The Task #2223 force-match test runs with `autoSave: false` to isolate the
 * force-refresh-before-gate ordering, so the persist path
 * (`applyAutoMatchCandidates` → `semrush_location_campaigns`) has no automated
 * coverage. A regression there would silently stop saving matches while the
 * API still returns a 200. This test exercises the default (`autoSave: true`)
 * branch end-to-end and asserts:
 *
 *   1. POST /api/clients/:clientId/semrush-location-campaigns/auto-match with
 *      `autoSave` left at its default (true) returns 200, matches the seeded
 *      location to the force-refreshed campaign, and the aggregate response
 *      reflects the save (`savedCount === 1`).
 *   2. A row is actually persisted in `semrush_location_campaigns` for the
 *      seeded client (clientId / locationId / semrushCampaignId triple).
 *   3. Re-running the same request is idempotent: the existing row is found
 *      (`alreadyMappedCount === 1`, `savedCount === 0`) and no duplicate row
 *      materialises — proving the first run truly persisted.
 *
 * As in the Task #2223 test, `forceRefreshCampaigns`' external dependencies
 * (connection probe, HTTP fetch/map, enrichment) are swapped out via
 * `__setForceRefreshCampaignsDepsForTest` so the orchestration runs without
 * SEMrush OAuth or the network.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  clearCampaignCache,
  __setForceRefreshCampaignsDepsForTest,
} from "../server/services/semrushApi";
import { registerHeatmapRoutes } from "../server/routes/heatmap";

const ACTOR_ID = "test-2260-account-manager";
const CLIENT_ID = "test-2260-client";
const LOCATION_ID = "test-2260-location";
const CAMPAIGN_ID = "task2260-campaign-1";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function seedFixtures(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${ACTOR_ID}, 'account_manager', ${"Task2260 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${"Task2260 Firm"})
    ON CONFLICT (id) DO UPDATE SET firm_name = EXCLUDED.firm_name
  `);
  await db.execute(sql`
    INSERT INTO client_locations (id, client_id, name, lat, lng)
    VALUES (${LOCATION_ID}, ${CLIENT_ID}, ${"Task2260 Office"}, 30.2672, -97.7431)
    ON CONFLICT (id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng
  `);
}

async function cleanupFixtures(): Promise<void> {
  try { await db.execute(sql`DELETE FROM semrush_location_campaigns WHERE client_id = ${CLIENT_ID}`); } catch {}
  try { await db.execute(sql`DELETE FROM client_semrush_integrations WHERE client_id = ${CLIENT_ID}`); } catch {}
  try { await db.execute(sql`DELETE FROM client_locations WHERE client_id = ${CLIENT_ID}`); } catch {}
  try { await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`); } catch {}
  try { await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`); } catch {}
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): the
    // real requireAuth middleware runs and resolves this id against the
    // committed public-schema users row seeded above.
    (req as any).__test_clerkUserId = ACTOR_ID;
    next();
  });
  registerHeatmapRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// A campaign whose base point sits exactly on the seeded location's
// coordinates so the auto-match proximity pass (≤5 miles) links them.
function makeCampaign() {
  return {
    id: CAMPAIGN_ID,
    businessName: "Task2260 Firm",
    location: "Austin, TX",
    keywords: [{ id: "kw-1", name: "personal injury lawyer", status: "active" }],
    gridSettings: { basePoint: { lat: 30.2672, lng: -97.7431 } },
  };
}

async function countPersistedRows(): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM semrush_location_campaigns
    WHERE client_id = ${CLIENT_ID}
      AND location_id = ${LOCATION_ID}
      AND semrush_campaign_id = ${CAMPAIGN_ID}
  `);
  return Number((rows.rows[0] as any).count);
}

async function autoMatchRequest(baseUrl: string, body: Record<string, unknown>) {
  const campaign = makeCampaign();
  __setForceRefreshCampaignsDepsForTest({
    getConnectionStatus: async () => ({
      connected: true,
      expired: false,
      disconnectReason: null,
      lastProbeError: null,
    }),
    fetchAndMapCampaigns: async () => [campaign] as any,
    enrichCampaigns: async () => {},
  });
  const res = await fetch(
    `${baseUrl}/api/clients/${CLIENT_ID}/semrush-location-campaigns/auto-match`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { res, json: await res.json() };
}

async function run(): Promise<void> {
  await seedFixtures();
  // Start from a clean slate so a stale row from a prior aborted run can't
  // mask a save regression (the persist would be classified already_mapped).
  await db.execute(sql`DELETE FROM semrush_location_campaigns WHERE client_id = ${CLIENT_ID}`);
  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // -------------------------------------------------------------------
    // Scenario 1 — autoSave default (true) persists the matched pair
    // -------------------------------------------------------------------
    {
      assertEq(await countPersistedRows(), 0, "precondition: no persisted row before auto-match");
      clearCampaignCache();

      // `autoSave` is intentionally omitted so the route's default
      // (`req.body?.autoSave !== false` ⇒ true) drives the persist branch.
      // `forceRefresh: true` makes the fresh campaign feed the matcher
      // deterministically without depending on a warm background cache.
      const { res, json } = await autoMatchRequest(baseUrl, { forceRefresh: true });

      assertEq(res.status, 200, "auto-match autoSave-default status");
      assert(json.status !== "enriching", "auto-match response must not be the enriching body");

      assert(Array.isArray(json.matched), "auto-match returns a matched array");
      const match = json.matched.find((m: any) => m.campaignId === CAMPAIGN_ID);
      assert(match, "the force-refreshed campaign was matched to a location");
      assertEq(match.locationId, LOCATION_ID, "campaign matched to the seeded location");

      // The aggregate response reflects the save.
      assertEq(json.savedCount, 1, "aggregate savedCount reflects one saved mapping");
      assertEq(json.alreadyMappedCount, 0, "no already-mapped rows on first save");
      assertEq(json.staleConflictCount, 0, "no stale conflicts on first save");
      assertEq(json.queuedForReviewCount, 0, "no review-queued rows (location is configured)");

      // The row is actually in the database.
      assertEq(await countPersistedRows(), 1, "exactly one persisted row after autoSave");
      console.log("  ✓ auto-match autoSave default persists the matched pair (savedCount=1, row in DB)");
    }

    // -------------------------------------------------------------------
    // Scenario 2 — re-running is idempotent (already_mapped, no duplicate)
    // -------------------------------------------------------------------
    {
      clearCampaignCache();
      const { res, json } = await autoMatchRequest(baseUrl, { forceRefresh: true });

      assertEq(res.status, 200, "auto-match re-run status");
      // The campaign is now in `existingMappings`, so every fetched campaign
      // is already mapped: the route short-circuits with the "All campaigns
      // already mapped" body (no fresh matches, nothing new saved).
      assert(Array.isArray(json.matched) && json.matched.length === 0, "re-run returns no fresh matches");
      assertEq(json.message, "All campaigns already mapped", "re-run reports all campaigns already mapped");

      // The triple is unchanged: still exactly one row, no duplicate insert.
      assertEq(await countPersistedRows(), 1, "no duplicate row after idempotent re-run");
      console.log("  ✓ auto-match re-run is idempotent (no duplicate persisted row)");
    }
  } finally {
    __setForceRefreshCampaignsDepsForTest(null);
    clearCampaignCache();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanupFixtures();
  }
}

run()
  .then(() => {
    console.log("semrush-auto-match-autosave-persist: all scenarios passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
