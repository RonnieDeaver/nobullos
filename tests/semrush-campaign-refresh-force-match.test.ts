/* test-registration
{
  "name": "SEMrush campaign force-refresh + force-match flow incl. name/location match types (Tasks #2223 / #2261)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2223 — integration tests for the SEMrush campaign force-refresh +
 * force-match flow shipped in Task #2185.
 *
 * Two surfaces are covered, both mounted on a minimal Express app whose
 * Clerk per-request test seam lets the real `isAuthenticated` +
 * `requireAccountManager` guards run against a seeded `account_manager`
 * user row:
 *
 *   1. POST /api/semrush/campaigns/refresh
 *        - success ⇒ 200 { status: "ready", campaigns, count }
 *        - connection gate failure ⇒ 401 (the route maps a
 *          "not connected" force-refresh error to 401)
 *
 *   2. POST /api/clients/:clientId/semrush-location-campaigns/auto-match
 *      with `forceRefresh: true` ⇒ the synchronous force-refresh runs
 *      BEFORE the enrichment gate: the cache is cleared (so the gate would
 *      otherwise block), yet the response is a 200 match result (not the
 *      202 "enriching" body), the freshly-fetched campaign feeds the
 *      matcher, and `isEnrichmentComplete()` is true afterwards.
 *
 * `forceRefreshCampaigns`' external dependencies (connection probe, the
 * HTTP fetch/map, enrichment) are swapped out via
 * `__setForceRefreshCampaignsDepsForTest` so the orchestration is exercised
 * without SEMrush OAuth or the network.
 *
 * Task #2261 extends this with two more auto-match scenarios that exercise
 * the non-proximity matching passes — both fire only when a campaign has no
 * usable coordinates:
 *
 *   4. a campaign matched by fuzzy business name ⇒ matchType "name"
 *   5. a campaign matched by fuzzy location/address string ⇒ matchType
 *      "location"
 *
 * Each reuses the same dependency seam + seeding helpers and asserts the
 * resulting `matchType` (and target location) in the response `matched`
 * array, so the name/location fallbacks can't regress unnoticed.
 *
 * Task #2272 extends this with the persist (`autoSave: true`) path, which the
 * earlier scenarios never exercise (they all run `autoSave: false`):
 *
 *   6. auto-match with `autoSave: true` ⇒ the proximity-matched campaign is
 *      actually written into `semrush_location_campaigns` linked to the
 *      expected office row, and the response's savedCount / alreadyMappedCount
 *      / queuedForReviewCount / staleConflictCount aggregation reflects the
 *      single fresh save (savedCount 1, the rest 0).
 *   7. re-running auto-match with `autoSave: true` for the same campaign ⇒ the
 *      canonical write helper's dedup makes it `already_mapped` (savedCount 0,
 *      alreadyMappedCount 1) and no duplicate row is inserted — exactly one
 *      row still links the campaign to the office.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  clearCampaignCache,
  isEnrichmentComplete,
  listCampaigns,
  __setForceRefreshCampaignsDepsForTest,
} from "../server/services/semrushApi";
import { registerHeatmapRoutes } from "../server/routes/heatmap";
import {
  applyAutoMatchCandidates,
  type AutoMatchCandidate,
} from "../server/services/semrushLocationMappingWriter";

const ACTOR_ID = "test-2223-account-manager";
const CLIENT_ID = "test-2223-client";
const LOCATION_ID = "test-2223-location";
// Task #2261 — extra locations used to exercise the name and location
// fallback matching passes, which only fire for campaigns that have no
// usable coordinates (so the proximity pass is skipped). Both sit far
// (>5 miles) from the proximity location above so they never steal the
// Task #2223 proximity assertion.
const NAME_LOCATION_ID = "test-2261-name-location";
const LOC_LOCATION_ID = "test-2261-loc-location";

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// node-postgres-backed drizzle `db.execute` returns `{ rows }`; normalise so
// the persist scenarios can read the written mapping rows back.
function rowsOf<T = any>(res: any): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && Array.isArray(res.rows)) return res.rows as T[];
  return [];
}

async function seedFixtures(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${ACTOR_ID}, 'account_manager', ${"Task2223 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${"Task2223 Firm"})
    ON CONFLICT (id) DO UPDATE SET firm_name = EXCLUDED.firm_name
  `);
  await db.execute(sql`
    INSERT INTO client_locations (id, client_id, name, lat, lng)
    VALUES (${LOCATION_ID}, ${CLIENT_ID}, ${"Task2223 Office"}, 30.2672, -97.7431)
    ON CONFLICT (id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng
  `);
  // Task #2261 — a location matched by business name. Its coordinates sit
  // in Houston (~145 miles from the Austin proximity location) so a
  // coordinate-bearing campaign would never proximity-match it.
  await db.execute(sql`
    INSERT INTO client_locations (id, client_id, name, city, state, lat, lng)
    VALUES (${NAME_LOCATION_ID}, ${CLIENT_ID}, ${"Hamilton Injury Lawyers"}, ${"Houston"}, ${"TX"}, 29.7604, -95.3698)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city, state = EXCLUDED.state, lat = EXCLUDED.lat, lng = EXCLUDED.lng
  `);
  // Task #2261 — a location matched by location/address string. In Denver,
  // CO (well outside the 5-mile proximity radius of either Texas office).
  await db.execute(sql`
    INSERT INTO client_locations (id, client_id, name, city, state, lat, lng)
    VALUES (${LOC_LOCATION_ID}, ${CLIENT_ID}, ${"Westside Office"}, ${"Denver"}, ${"CO"}, 39.7392, -104.9903)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city, state = EXCLUDED.state, lat = EXCLUDED.lat, lng = EXCLUDED.lng
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
    id: "task2223-campaign-1",
    businessName: "Task2223 Firm",
    location: "Austin, TX",
    keywords: [{ id: "kw-1", name: "personal injury lawyer", status: "active" }],
    gridSettings: { basePoint: { lat: 30.2672, lng: -97.7431 } },
  };
}

// Task #2261 — a campaign with NO coordinates whose business name exactly
// matches the seeded "Hamilton Injury Lawyers" location. With no base point
// the proximity pass is skipped, so this can only link via the fuzzy
// business-name pass (matchType "name"). Its location string is deliberately
// empty so it cannot also fall through to the location pass.
function makeNameMatchCampaign() {
  return {
    id: "task2261-name-campaign",
    businessName: "Hamilton Injury Lawyers",
    location: "",
    keywords: [{ id: "kw-name-1", name: "injury lawyer", status: "active" }],
    gridSettings: {},
  };
}

// Task #2261 — a campaign with NO coordinates whose business name matches no
// location, but whose location string ("Denver, CO") matches the seeded
// "Westside Office" location's city/state. Skips proximity (no coords),
// skips the name pass (no business-name overlap), and links via the fuzzy
// location/address pass (matchType "location").
function makeLocationMatchCampaign() {
  return {
    id: "task2261-location-campaign",
    businessName: "Northstar Digital",
    location: "Denver, CO",
    keywords: [{ id: "kw-loc-1", name: "car accident attorney", status: "active" }],
    gridSettings: {},
  };
}

async function run(): Promise<void> {
  await seedFixtures();
  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // -------------------------------------------------------------------
    // Scenario 1 — refresh route success ⇒ 200 { status, campaigns, count }
    // -------------------------------------------------------------------
    {
      clearCampaignCache();
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

      const res = await fetch(`${baseUrl}/api/semrush/campaigns/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await res.json();
      assertEq(res.status, 200, "refresh success status");
      assertEq(body.status, "ready", "refresh success body.status");
      assertEq(body.count, 1, "refresh success body.count");
      assert(Array.isArray(body.campaigns) && body.campaigns.length === 1, "refresh returns one campaign");
      assertEq(body.campaigns[0].id, campaign.id, "refresh campaign id echoed");
      console.log("  ✓ POST /campaigns/refresh success ⇒ 200 { status:ready, campaigns, count }");
    }

    // -------------------------------------------------------------------
    // Scenario 2 — refresh route connection-gate failure ⇒ 401
    // -------------------------------------------------------------------
    {
      clearCampaignCache();
      __setForceRefreshCampaignsDepsForTest({
        getConnectionStatus: async () => ({
          connected: false,
          expired: false,
          disconnectReason: "revoked",
          lastProbeError: null,
        }),
      });

      const res = await fetch(`${baseUrl}/api/semrush/campaigns/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await res.json();
      assertEq(res.status, 401, "refresh auth-error status");
      assert(
        typeof body.error === "string" && body.error.toLowerCase().includes("not connected"),
        `refresh auth-error body.error mentions "not connected" (got ${JSON.stringify(body.error)})`,
      );
      console.log("  ✓ POST /campaigns/refresh connection gate failure ⇒ 401");
    }

    // -------------------------------------------------------------------
    // Scenario 3 — auto-match forceRefresh runs BEFORE the enrichment gate
    // -------------------------------------------------------------------
    {
      // Clear the cache so the enrichment gate WOULD block were it reached
      // before the force-refresh: nothing is ready yet.
      clearCampaignCache();
      assertEq(isEnrichmentComplete(), false, "precondition: enrichment not complete after cache clear");

      const campaign = makeCampaign();
      let fetchCallCount = 0;
      __setForceRefreshCampaignsDepsForTest({
        getConnectionStatus: async () => ({
          connected: true,
          expired: false,
          disconnectReason: null,
          lastProbeError: null,
        }),
        fetchAndMapCampaigns: async () => {
          fetchCallCount += 1;
          return [campaign] as any;
        },
        enrichCampaigns: async () => {},
      });

      const res = await fetch(
        `${baseUrl}/api/clients/${CLIENT_ID}/semrush-location-campaigns/auto-match`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceRefresh: true, autoSave: false }),
        },
      );
      const body = await res.json();

      // The force-refresh ran exactly once and made the gate pass, so the
      // route returns a real 200 match result rather than the 202 enriching
      // body it would emit if the gate had blocked against the empty cache.
      assertEq(fetchCallCount, 1, "force-refresh fetch ran exactly once");
      assertEq(res.status, 200, "auto-match forceRefresh status (not 202 enriching)");
      assert(body.status !== "enriching", "auto-match response must not be the enriching body");
      assertEq(isEnrichmentComplete(), true, "enrichment marked complete after force-refresh");

      // The freshly-fetched campaign fed the matcher: the seeded location is
      // matched to it (proximity), proving the refreshed list — not a stale
      // cache — drove matching.
      assert(Array.isArray(body.matched), "auto-match returns a matched array");
      const match = body.matched.find((m: any) => m.campaignId === campaign.id);
      assert(match, "the force-refreshed campaign was matched to a location");
      assertEq(match.locationId, LOCATION_ID, "campaign matched to the seeded location");

      // listCampaigns now serves the refreshed list from cache.
      const cached = await listCampaigns();
      assert(
        cached.some((c) => c.id === campaign.id),
        "listCampaigns serves the force-refreshed campaign from cache",
      );
      console.log("  ✓ auto-match forceRefresh=true force-refreshes BEFORE the enrichment gate");
    }

    // -------------------------------------------------------------------
    // Scenario 4 (Task #2261) — a coordinate-less campaign links by
    // business name ⇒ matchType "name"
    // -------------------------------------------------------------------
    {
      clearCampaignCache();
      const campaign = makeNameMatchCampaign();
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
          body: JSON.stringify({ forceRefresh: true, autoSave: false }),
        },
      );
      const body = await res.json();

      assertEq(res.status, 200, "name-match status");
      assert(Array.isArray(body.matched), "name-match returns a matched array");
      const match = body.matched.find((m: any) => m.campaignId === campaign.id);
      assert(match, "the coordinate-less campaign was matched by business name");
      assertEq(match.matchType, "name", "name-match matchType is \"name\"");
      assertEq(match.locationId, NAME_LOCATION_ID, "name-match linked to the Hamilton location");
      console.log("  ✓ coordinate-less campaign matched by business name ⇒ matchType \"name\"");
    }

    // -------------------------------------------------------------------
    // Scenario 5 (Task #2261) — a coordinate-less campaign whose name
    // matches nothing links by location string ⇒ matchType "location"
    // -------------------------------------------------------------------
    {
      clearCampaignCache();
      const campaign = makeLocationMatchCampaign();
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
          body: JSON.stringify({ forceRefresh: true, autoSave: false }),
        },
      );
      const body = await res.json();

      assertEq(res.status, 200, "location-match status");
      assert(Array.isArray(body.matched), "location-match returns a matched array");
      const match = body.matched.find((m: any) => m.campaignId === campaign.id);
      assert(match, "the coordinate-less campaign was matched by location string");
      assertEq(match.matchType, "location", "location-match matchType is \"location\"");
      assertEq(match.locationId, LOC_LOCATION_ID, "location-match linked to the Westside (Denver) location");
      console.log("  ✓ coordinate-less campaign matched by location string ⇒ matchType \"location\"");
    }

    // -------------------------------------------------------------------
    // Scenario 6 (Task #2272) — autoSave:true PERSISTS the match into
    // semrush_location_campaigns linked to the right office, and the
    // response aggregation reports the single fresh save.
    // -------------------------------------------------------------------
    {
      // Start from a clean mapping table for this client so the save count
      // is unambiguous regardless of prior scenarios.
      await db.execute(sql`DELETE FROM semrush_location_campaigns WHERE client_id = ${CLIENT_ID}`);

      clearCampaignCache();
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
          body: JSON.stringify({ forceRefresh: true, autoSave: true }),
        },
      );
      const body = await res.json();

      assertEq(res.status, 200, "autoSave persist status");
      // The proximity-matched campaign was matched to the seeded office.
      const match = body.matched.find((m: any) => m.campaignId === campaign.id);
      assert(match, "autoSave: campaign was matched before persist");
      assertEq(match.locationId, LOCATION_ID, "autoSave: matched to the seeded office");

      // The response aggregation reports exactly one fresh save.
      assertEq(body.savedCount, 1, "autoSave savedCount is 1");
      assertEq(body.alreadyMappedCount, 0, "autoSave alreadyMappedCount is 0");
      assertEq(body.queuedForReviewCount, 0, "autoSave queuedForReviewCount is 0");
      assertEq(body.staleConflictCount, 0, "autoSave staleConflictCount is 0");

      // The persisted row actually links THIS campaign to THIS office and is
      // not flagged stale.
      const persisted = rowsOf(await db.execute(sql`
        SELECT location_id, semrush_campaign_id, semrush_campaign_name, is_stale
        FROM semrush_location_campaigns
        WHERE client_id = ${CLIENT_ID} AND semrush_campaign_id = ${campaign.id}
      `));
      assertEq(persisted.length, 1, "autoSave wrote exactly one mapping row");
      assertEq(persisted[0].location_id, LOCATION_ID, "persisted row links to the seeded office");
      assertEq(persisted[0].semrush_campaign_name, campaign.businessName, "persisted row carries the campaign name");
      assertEq(persisted[0].is_stale, false, "persisted row is not stale");
      console.log("  ✓ autoSave:true persists the proximity match to the right office (savedCount 1)");
    }

    // -------------------------------------------------------------------
    // Scenario 7 (Task #2272) — the persist aggregation across ALL four
    // outcome counters.
    //
    // The route response only ever surfaces a non-zero `savedCount` because
    // the handler filters already-mapped campaign IDs out *before* the
    // persist phase (an already-mapped campaign short-circuits with "All
    // campaigns already mapped" and never reaches `applyAutoMatchCandidates`).
    // So `alreadyMappedCount` / `queuedForReviewCount` / `staleConflictCount`
    // are exercised by driving the named aggregation helper directly with a
    // batch crafted to hit each outcome — this is the function whose counters
    // feed the route response, so pinning it here guards the same numbers the
    // response returns.
    // -------------------------------------------------------------------
    {
      // Clean slate, then pre-seed the rows that produce the non-saved
      // outcomes:
      //   - a LIVE row so the same triple re-applies as `already_mapped`
      //   - a STALE-only row so its triple re-applies as `stale_conflict`
      //     (the helper never auto-revives stale rows)
      await db.execute(sql`DELETE FROM semrush_location_campaigns WHERE client_id = ${CLIENT_ID}`);
      const ALREADY_CAMPAIGN = "task2272-already-campaign";
      const STALE_CAMPAIGN = "task2272-stale-campaign";
      const FRESH_CAMPAIGN = "task2272-fresh-campaign";
      const ORPHAN_CAMPAIGN = "task2272-orphan-campaign";
      const UNCONFIGURED_LOCATION = "task2272-unconfigured-location";

      await db.execute(sql`
        INSERT INTO semrush_location_campaigns (client_id, location_id, semrush_campaign_id, semrush_campaign_name, is_stale)
        VALUES (${CLIENT_ID}, ${LOCATION_ID}, ${ALREADY_CAMPAIGN}, ${"Already Mapped Co"}, false)
      `);
      await db.execute(sql`
        INSERT INTO semrush_location_campaigns (client_id, location_id, semrush_campaign_id, semrush_campaign_name, is_stale, stale_since)
        VALUES (${CLIENT_ID}, ${NAME_LOCATION_ID}, ${STALE_CAMPAIGN}, ${"Stale Co"}, true, now())
      `);

      const candidates: AutoMatchCandidate[] = [
        // configured parent, no existing row ⇒ saved
        { locationId: LOC_LOCATION_ID, campaignId: FRESH_CAMPAIGN, campaignName: "Fresh Co", matchType: "location" },
        // configured parent, live row already exists ⇒ already_mapped
        { locationId: LOCATION_ID, campaignId: ALREADY_CAMPAIGN, campaignName: "Already Mapped Co", matchType: "proximity" },
        // unconfigured parent (location not in client_locations) ⇒ invalid_parent ⇒ queuedForReviewCount
        { locationId: UNCONFIGURED_LOCATION, campaignId: ORPHAN_CAMPAIGN, campaignName: "Orphan Co", matchType: "name" },
        // configured parent but only a stale row exists ⇒ stale_conflict (never auto-revived)
        { locationId: NAME_LOCATION_ID, campaignId: STALE_CAMPAIGN, campaignName: "Stale Co", matchType: "proximity" },
      ];

      const agg = await applyAutoMatchCandidates(CLIENT_ID, candidates);

      assertEq(agg.savedCount, 1, "aggregate savedCount is 1");
      assertEq(agg.alreadyMappedCount, 1, "aggregate alreadyMappedCount is 1");
      assertEq(agg.queuedForReviewCount, 1, "aggregate queuedForReviewCount is 1 (unconfigured parent)");
      assertEq(agg.staleConflictCount, 1, "aggregate staleConflictCount is 1");

      // The unconfigured-parent and stale-conflict candidates are surfaced as
      // operator-visible dropped warnings with their distinguishing reasons.
      assert(
        agg.droppedWarnings.some((w) => w.campaignId === ORPHAN_CAMPAIGN && w.reason === "unconfigured_location"),
        "unconfigured-location candidate surfaced as a dropped warning",
      );
      assert(
        agg.droppedWarnings.some((w) => w.campaignId === STALE_CAMPAIGN && w.reason === "stale_conflict"),
        "stale-conflict candidate surfaced as a dropped warning",
      );

      // The freshly-saved candidate is the ONLY new live row written by this
      // batch: it links the fresh campaign to its configured office.
      const savedRow = rowsOf(await db.execute(sql`
        SELECT location_id, is_stale FROM semrush_location_campaigns
        WHERE client_id = ${CLIENT_ID} AND semrush_campaign_id = ${FRESH_CAMPAIGN}
      `));
      assertEq(savedRow.length, 1, "the saved candidate wrote exactly one row");
      assertEq(savedRow[0].location_id, LOC_LOCATION_ID, "saved row links to its configured office");
      assertEq(savedRow[0].is_stale, false, "saved row is live, not stale");

      // The stale-conflict candidate did NOT write a new live row — only the
      // pre-seeded stale row remains for that triple.
      const staleRows = rowsOf(await db.execute(sql`
        SELECT is_stale FROM semrush_location_campaigns
        WHERE client_id = ${CLIENT_ID} AND semrush_campaign_id = ${STALE_CAMPAIGN}
      `));
      assertEq(staleRows.length, 1, "stale-conflict candidate added no extra row");
      assertEq(staleRows[0].is_stale, true, "stale row was not auto-revived");

      // The unconfigured-parent candidate wrote no mapping row at all.
      const orphanRows = rowsOf(await db.execute(sql`
        SELECT id FROM semrush_location_campaigns
        WHERE client_id = ${CLIENT_ID} AND semrush_campaign_id = ${ORPHAN_CAMPAIGN}
      `));
      assertEq(orphanRows.length, 0, "unconfigured-parent candidate wrote no mapping row");

      // Clean up the suggestion row the invalid_parent path queues so it does
      // not leak into other clients' review queues.
      try { await db.execute(sql`DELETE FROM import_entity_suggestions WHERE client_id = ${CLIENT_ID}`); } catch {}
      console.log("  ✓ applyAutoMatchCandidates aggregates saved / already_mapped / queued_for_review / stale_conflict");
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
    console.log("semrush-campaign-refresh-force-match: all scenarios passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
