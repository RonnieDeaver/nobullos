/* test-registration
{
  "name": "Semrush auto match autosave review queue (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2270 — review-queue coverage for the SEMrush auto-match endpoint.
 *
 * Task #2260 pins the happy path: a campaign matched to a *configured*
 * location persists a `semrush_location_campaigns` row (`savedCount === 1`).
 * The opposite, safety-critical branch — a campaign matched to a location
 * that is unconfigured / policy-blocked by the time the persist helper
 * re-reads `client_locations` — had no HTTP-level coverage. A regression
 * there could silently write a mapping row for an unconfigured parent (or
 * stop queuing it for review) while the API still returns 200.
 *
 * This test drives POST
 * /api/clients/:clientId/semrush-location-campaigns/auto-match with `autoSave`
 * left at its default (true) and asserts the route safely QUEUES the
 * mismatched candidate:
 *
 *   1. NO row is written to `semrush_location_campaigns` for the triple.
 *   2. The aggregate response reports `queuedForReviewCount === 1` and
 *      `savedCount === 0`, with the candidate surfaced in `warnings` as an
 *      `unconfigured_location` drop.
 *   3. A `pending` `import_entity_suggestions` row materialises for the
 *      (clientId, locationId, semrushCampaignId) triple.
 *
 * The route matches against the in-memory `locations` snapshot captured in
 * the "fetch" phase, while the persist helper independently re-reads
 * `client_locations`. To make the snapshot-vs-reread divergence deterministic
 * (no timing, no flake) the test uses the route's `__setAutoMatchAfterFetchHook
 * ForTest` seam to delete the parent location in the exact gap between the two
 * phases. `forceRefreshCampaigns`' external dependencies are swapped via
 * `__setForceRefreshCampaignsDepsForTest` so the run needs no SEMrush OAuth or
 * network, exactly as in the Task #2223 / #2260 tests.
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
import {
  registerHeatmapRoutes,
  __setAutoMatchAfterFetchHookForTest,
} from "../server/routes/heatmap";

const ACTOR_ID = "test-2270-account-manager";
const CLIENT_ID = "test-2270-client";
const LOCATION_ID = "test-2270-location";
const CAMPAIGN_ID = "task2270-campaign-1";

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
    VALUES (${ACTOR_ID}, 'account_manager', ${"Task2270 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${"Task2270 Firm"})
    ON CONFLICT (id) DO UPDATE SET firm_name = EXCLUDED.firm_name
  `);
  await db.execute(sql`
    INSERT INTO client_locations (id, client_id, name, lat, lng)
    VALUES (${LOCATION_ID}, ${CLIENT_ID}, ${"Task2270 Office"}, 30.2672, -97.7431)
    ON CONFLICT (id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng
  `);
}

async function cleanupFixtures(): Promise<void> {
  try { await db.execute(sql`DELETE FROM import_entity_suggestions WHERE client_id = ${CLIENT_ID}`); } catch {}
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
    businessName: "Task2270 Firm",
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

async function countPendingSuggestions(): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM import_entity_suggestions
    WHERE client_id = ${CLIENT_ID}
      AND entity_kind = 'location_mapping'
      AND status = 'pending'
      AND candidate->>'locationId' = ${LOCATION_ID}
      AND candidate->>'semrushCampaignId' = ${CAMPAIGN_ID}
  `);
  return Number((rows.rows[0] as any).count);
}

async function run(): Promise<void> {
  await seedFixtures();
  // Start from a clean slate so a stale row from a prior aborted run cannot
  // mask the assertions.
  await db.execute(sql`DELETE FROM semrush_location_campaigns WHERE client_id = ${CLIENT_ID}`);
  await db.execute(sql`DELETE FROM import_entity_suggestions WHERE client_id = ${CLIENT_ID}`);

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

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

  // After the matcher's `locations` snapshot is taken (so the campaign still
  // matches the seeded office) but before the persist helper re-reads
  // `client_locations`, remove the parent row. The helper then finds no
  // parent and routes the candidate to the review queue instead of writing a
  // mapping for an unconfigured location.
  let hookFired = 0;
  __setAutoMatchAfterFetchHookForTest(async () => {
    hookFired += 1;
    await db.execute(sql`DELETE FROM client_locations WHERE id = ${LOCATION_ID}`);
  });

  try {
    assertEq(await countPersistedRows(), 0, "precondition: no persisted row before auto-match");
    assertEq(await countPendingSuggestions(), 0, "precondition: no pending suggestion before auto-match");
    clearCampaignCache();

    // `autoSave` is intentionally omitted so the route's default
    // (`req.body?.autoSave !== false` ⇒ true) drives the persist branch.
    // `forceRefresh: true` feeds the fresh campaign to the matcher without a
    // warm background cache.
    const res = await fetch(
      `${baseUrl}/api/clients/${CLIENT_ID}/semrush-location-campaigns/auto-match`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceRefresh: true }),
      },
    );
    const json = await res.json();

    assertEq(res.status, 200, "auto-match autoSave-default status");
    assert(json.status !== "enriching", "auto-match response must not be the enriching body");
    assertEq(hookFired, 1, "after-fetch seam ran exactly once");

    // The campaign matched the seeded office from the in-memory snapshot.
    assert(Array.isArray(json.matched), "auto-match returns a matched array");
    const match = json.matched.find((m: any) => m.campaignId === CAMPAIGN_ID);
    assert(match, "the force-refreshed campaign was matched to a location");
    assertEq(match.locationId, LOCATION_ID, "campaign matched to the seeded location");

    // The aggregate response reflects a safe queue-for-review, not a save.
    assertEq(json.savedCount, 0, "nothing saved for an unconfigured parent");
    assertEq(json.queuedForReviewCount, 1, "the mismatched candidate is queued for review");
    assertEq(json.alreadyMappedCount, 0, "no already-mapped rows");
    assertEq(json.staleConflictCount, 0, "no stale conflicts");

    // The candidate is surfaced to operators as an unconfigured-location drop.
    assert(Array.isArray(json.warnings), "response carries a warnings array");
    const warning = json.warnings.find(
      (w: any) => w.locationId === LOCATION_ID && w.campaignId === CAMPAIGN_ID,
    );
    assert(warning, "the queued candidate appears in warnings");
    assertEq(warning.reason, "unconfigured_location", "warning reason is unconfigured_location");

    // No mapping row was written for the unconfigured parent.
    assertEq(await countPersistedRows(), 0, "no semrush_location_campaigns row written");

    // A pending review suggestion materialised for the triple.
    assertEq(await countPendingSuggestions(), 1, "exactly one pending review suggestion created");

    console.log("  ✓ auto-match autoSave default safely queues an unconfigured candidate for review (no mapping row, suggestion created)");
  } finally {
    __setAutoMatchAfterFetchHookForTest(null);
    __setForceRefreshCampaignsDepsForTest(null);
    clearCampaignCache();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanupFixtures();
  }
}

run()
  .then(() => {
    console.log("semrush-auto-match-autosave-review-queue: all scenarios passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
