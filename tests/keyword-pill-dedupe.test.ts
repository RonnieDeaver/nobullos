/* test-registration
{
  "name": "Keyword pill dedupe by normalized form + report-month auto-pull dedupe (Tasks #2451, #4848)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot. Task #4848 adds the report-month auto-pull contract in the same seeded harness: getSnapshotIdsForReportMonth must return ONE snapshot per (location, keyword) — the latest in-window scan across campaigns — instead of every weekly SEMrush scan; the pre-fix behavior shipped ~60 prod reports whose share decks render 4 near-identical maps per location.",
  "tier": "small"
}
test-registration */
/**
 * Task #2451 — Dedupe Local Dominance keyword pills by the canonical normalized
 * keyword form.
 *
 * SEMrush returns the same keyword under inconsistent casing/whitespace across a
 * client's campaigns and sync dates ("immigration attorney" vs
 * "Immigration Attorney" vs "immigration  attorney"). The keyword-pill endpoint
 * used to dedupe by the RAW stored string, so each spelling survived and became
 * its own pill. This pins the read-path fix:
 *
 *   1. GET /api/clients/:clientId/local-dominance/keywords returns EXACTLY ONE
 *      pill for a keyword stored under three raw spellings across two campaigns.
 *
 *   2. Selecting that single pill (GET .../location-snapshots?keyword=<label>)
 *      still surfaces snapshots from BOTH campaigns/locations, including the one
 *      whose stored spelling differs from the pill label — proving the read
 *      filter matches every variant via the normalized form.
 *
 *   3. A genuinely distinct keyword still gets its own separate pill (no
 *      over-collapse regression).
 *
 *   4. Task #4848 — the ReportForm auto-pull lane. The SEMrush tracker scans
 *      weekly, so a report-month window holds ~4 same-keyword snapshots;
 *      `getSnapshotIdsForReportMonth` used to return them ALL, and every
 *      stored id became its own full map card on the public share deck
 *      (verified prod shape: Ashley Andrews July 2026 — four weekly "divorce
 *      lawyer" scans → four near-identical Arcadia maps). The service must
 *      keep only the LATEST in-window scan per (location, keyword):
 *        - weekly duplicates collapse to the newest, ACROSS campaigns mapped
 *          to the same location (the newest scan may come from a second
 *          campaign);
 *        - distinct keywords keep their own ids, latest-first order preserved
 *          (the first id stays the primary snapshot);
 *        - a snapshot whose campaign is NOT mapped to its location is ignored
 *          entirely — it must not be selected AND must not mark its keyword
 *          as seen (it is newer than the legit winner here, so a
 *          mark-before-filter bug would drop the winner);
 *        - out-of-window rows (before the month, after the +3-day grace) stay
 *          excluded; the same keyword at ANOTHER location keeps its own id
 *          (dedupe is per-location, never cross-location).
 *
 * The endpoints query the real `db`, so the test seeds real client / location /
 * mapping / snapshot rows (cleaned up in `finally`) and mounts the real
 * `registerHeatmapRoutes`. The access middleware's `storage.getUser` is stubbed
 * to an account_manager (read access) while `storage.getClient` hits the seeded
 * client. Scenario 4 uses a SEPARATE client so the pill-count asserts above
 * stay isolated from its extra snapshots. The local-server fetches go through
 * undici, whose keep-alive sockets are closed at the end so the process drains
 * naturally.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "net";

import { db, closeDbPools } from "../server/db";
import {
  clients,
  clientLocations,
  semrushLocationCampaigns,
  heatmapSnapshots,
} from "@shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { registerHeatmapRoutes } from "../server/routes/heatmap";
import { getSnapshotIdsForReportMonth } from "../server/services/heatmapService";
import { storage } from "../server/storage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// Migration 0061 added a plain CHECK constraint that forces every stored
// `keyword_name` to already be canonical, so going forward dev/prod cannot
// insert the non-canonical variants this fix is about. To reproduce the legacy
// prod data shape (the same keyword under different raw spellings across
// campaigns) we temporarily drop the constraint for the duration of the test
// and ALWAYS restore it in teardown (after deleting our own rows). The restore
// is also attempted up-front as a self-heal in case a previous crashed run left
// it dropped.
const KEYWORD_CHK = "heatmap_snapshots_keyword_name_canonical_chk";

async function dropKeywordCanonicalCheck(): Promise<void> {
  await db.execute(
    sql.raw(`ALTER TABLE heatmap_snapshots DROP CONSTRAINT IF EXISTS ${KEYWORD_CHK};`),
  );
}

async function restoreKeywordCanonicalCheck(): Promise<void> {
  // Task #3785 — the presence check MUST be schema-qualified: leaked
  // isolated-schema clones (test_iso_*) carry a same-named constraint, and
  // an unqualified conname match sees those, skips the restore, and leaks
  // the PUBLIC constraint as dropped for every later suite in the sweep.
  const present = await db.execute(
    sql.raw(
      `SELECT 1 FROM pg_constraint WHERE conname = '${KEYWORD_CHK}' ` +
        `AND connamespace = 'public'::regnamespace;`,
    ),
  );
  const rows = (present as any).rows ?? present;
  if (Array.isArray(rows) && rows.length > 0) return;
  try {
    await db.execute(
      sql.raw(
        `ALTER TABLE heatmap_snapshots ADD CONSTRAINT ${KEYWORD_CHK} ` +
          `CHECK (keyword_name = lower(regexp_replace(btrim(keyword_name), '\\s+', ' ', 'g')));`,
      ),
    );
  } catch (err) {
    console.error(
      `[keyword-pill-dedupe] FAILED to restore ${KEYWORD_CHK} — a non-canonical row may exist; ` +
        `manual cleanup required.`,
      err,
    );
    throw err;
  }
}

const USER_ID = "user-2451-am";
const TEST_TAG = `kpd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// storage stub — only getUser, so the access middleware grants read access.
// getClient hits the real (seeded) client row.
// ---------------------------------------------------------------------------
const s = storage as any;
let originalGetUser: any;

function installStubs(): void {
  originalGetUser = s.getUser;
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "am-2451@test.local",
          firstName: "Key",
          lastName: "Word",
          role: "account_manager",
        }
      : undefined;
  // requireAuth resolves the local user via its direct ambient `db` import, not
  // storage.getUser — and USER_ID is never written to the DB. Pre-register the
  // profile so requireAuth uses it directly (no JIT provision / comms auto-join)
  // while the access middleware keeps reading the stubbed storage.getUser above.
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "am-2451@test.local",
    firstName: "Key",
    lastName: "Word",
    role: "account_manager",
  });
}

function restoreStubs(): void {
  if (originalGetUser) s.getUser = originalGetUser;
  __test_resetReconciledUsers();
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------
async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated. The
    // pre-Clerk passport-shape injection stopped working when auth migrated.
    req.__test_clerkUserId = USER_ID;
    next();
  });
  registerHeatmapRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { "Content-Type": "application/json" } });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON body is itself a failure the asserts catch */
  }
  return { status: r.status, json };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
async function seedClient(nameSuffix = ""): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({ firmName: `KPD ${TEST_TAG}${nameSuffix}` })
    .returning({ id: clients.id });
  return row.id;
}

async function seedLocation(clientId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(clientLocations)
    .values({ clientId, name })
    .returning({ id: clientLocations.id });
  return row.id;
}

async function seedMapping(clientId: string, locationId: string, campaignId: string): Promise<void> {
  await db.insert(semrushLocationCampaigns).values({
    clientId,
    locationId,
    semrushCampaignId: campaignId,
    semrushCampaignName: `Camp ${campaignId}`,
    isStale: false,
  });
}

function snapBase(
  clientId: string,
  overrides: Partial<typeof heatmapSnapshots.$inferInsert> = {},
): typeof heatmapSnapshots.$inferInsert {
  return {
    clientId,
    locationName: "Test",
    businessName: "Test",
    campaignId: "camp",
    keywordId: "kw-x",
    keywordName: "immigration attorney",
    reportDate: new Date("2026-05-01T00:00:00Z"),
    businessLat: 40,
    businessLng: -75,
    gridTemplate: "9x9",
    gridUnit: "MILES",
    gridDistance: 5,
    baseLat: 40,
    baseLng: -75,
    pointsNumber: 1,
    shareOfVoiceRaw: 50,
    rawPayload: {} as any,
    ...overrides,
  };
}

async function main(): Promise<void> {
  installStubs();

  // Self-heal: if a prior crashed run left the constraint dropped, put it back
  // before we start (no-op when already present).
  await restoreKeywordCanonicalCheck();
  await dropKeywordCanonicalCheck();

  const clientId = await seedClient();
  const locA = await seedLocation(clientId, "Loc A");
  const locB = await seedLocation(clientId, "Loc B");
  const campA = `camp-${TEST_TAG}-A`;
  const campB = `camp-${TEST_TAG}-B`;
  await seedMapping(clientId, locA, campA);
  await seedMapping(clientId, locB, campB);

  const insertedIds: string[] = [];
  let monthClientId: string | null = null;
  try {
    // campA / locA stores the keyword as "Immigration Attorney" (newest date),
    // campB / locB stores the SAME keyword as "immigration  attorney" (double
    // space, older date). Same normalized form, different raw spellings, two
    // campaigns/locations.
    const [s1] = await db
      .insert(heatmapSnapshots)
      .values(
        snapBase(clientId, {
          locationId: locA,
          locationName: "Loc A",
          campaignId: campA,
          keywordName: "Immigration Attorney",
          shareOfVoiceRaw: 77,
          reportDate: new Date("2026-05-10T00:00:00Z"),
        }),
      )
      .returning({ id: heatmapSnapshots.id });
    insertedIds.push(s1.id);

    const [s2] = await db
      .insert(heatmapSnapshots)
      .values(
        snapBase(clientId, {
          locationId: locB,
          locationName: "Loc B",
          campaignId: campB,
          keywordName: "immigration  attorney",
          shareOfVoiceRaw: 42,
          reportDate: new Date("2026-05-05T00:00:00Z"),
        }),
      )
      .returning({ id: heatmapSnapshots.id });
    insertedIds.push(s2.id);

    // A genuinely distinct keyword on campA — must remain its own pill.
    const [s3] = await db
      .insert(heatmapSnapshots)
      .values(
        snapBase(clientId, {
          locationId: locA,
          locationName: "Loc A",
          campaignId: campA,
          keywordName: "deportation defense",
          shareOfVoiceRaw: 33,
          reportDate: new Date("2026-05-09T00:00:00Z"),
        }),
      )
      .returning({ id: heatmapSnapshots.id });
    insertedIds.push(s3.id);

    await withApp(async (baseUrl) => {
      // --- 1. keyword pills dedupe by normalized form ---
      console.log("\n— 1. keyword pills dedupe by normalized form —");
      const { status, json } = await getJson(
        baseUrl,
        `/api/clients/${clientId}/local-dominance/keywords`,
      );
      check("keywords endpoint → 200", status === 200, `status=${status}`);
      const pills: Array<{ keyword: string; campaignId: string }> = Array.isArray(json) ? json : [];

      const immigrationPills = pills.filter(
        (p) => p.keyword.trim().replace(/\s+/g, " ").toLowerCase() === "immigration attorney",
      );
      check(
        "exactly ONE pill for the three-spelling keyword",
        immigrationPills.length === 1,
        `got ${immigrationPills.length}: ${JSON.stringify(immigrationPills.map((p) => p.keyword))}`,
      );
      check(
        "distinct keyword still gets its own pill",
        pills.some(
          (p) => p.keyword.trim().replace(/\s+/g, " ").toLowerCase() === "deportation defense",
        ),
        JSON.stringify(pills.map((p) => p.keyword)),
      );
      check(
        "exactly two pills total (one per distinct normalized keyword)",
        pills.length === 2,
        `got ${pills.length}: ${JSON.stringify(pills.map((p) => p.keyword))}`,
      );

      // --- 2. selecting the single pill surfaces BOTH campaigns/locations ---
      console.log("\n— 2. selecting the deduped pill matches every spelling —");
      const label = immigrationPills[0]?.keyword ?? "immigration attorney";
      const res2 = await getJson(
        baseUrl,
        `/api/clients/${clientId}/local-dominance/location-snapshots?keyword=${encodeURIComponent(label)}`,
      );
      check("location-snapshots → 200", res2.status === 200, `status=${res2.status}`);
      const snaps: any[] = Array.isArray(res2.json) ? res2.json : [];
      const byLoc = new Map(snaps.map((r) => [r.locationId, r]));

      const a = byLoc.get(locA);
      const b = byLoc.get(locB);
      check(
        "locA snapshot resolved for the selected keyword",
        !!a && a.snapshotId === s1.id && a.shareOfVoice === 77,
        `snapshotId=${a?.snapshotId} sov=${a?.shareOfVoice}`,
      );
      check(
        "locB snapshot (different raw spelling) ALSO resolved via normalized match",
        !!b && b.snapshotId === s2.id && b.shareOfVoice === 42,
        `snapshotId=${b?.snapshotId} sov=${b?.shareOfVoice}`,
      );
    });

    // --- 4. Task #4848 — report-month auto-pull dedupes to one per keyword ---
    console.log("\n— 4. report-month auto-pull keeps one snapshot per (location, keyword) —");
    monthClientId = await seedClient("-month");
    const locC = await seedLocation(monthClientId, "Loc C");
    const locD = await seedLocation(monthClientId, "Loc D");
    const campC1 = `camp-${TEST_TAG}-C1`;
    const campC2 = `camp-${TEST_TAG}-C2`;
    const campD = `camp-${TEST_TAG}-D`;
    await seedMapping(monthClientId, locC, campC1);
    await seedMapping(monthClientId, locC, campC2);
    await seedMapping(monthClientId, locD, campD);

    // Weekly-scan shape pinned from the Ashley Andrews July 2026 prod report:
    // one keyword scanned Jul 13 / Jul 20 / Jul 27 / Aug 3 (the Aug 3 scan
    // falls inside the +3-day grace the month window deliberately keeps).
    // Dates use LOCAL-time constructors because the service builds its window
    // bounds with local-time Date components.
    const seedMonthSnap = async (
      locationId: string,
      locationName: string,
      campaignId: string,
      keywordName: string,
      reportDate: Date,
    ): Promise<string> => {
      const [row] = await db
        .insert(heatmapSnapshots)
        .values(snapBase(monthClientId!, { locationId, locationName, campaignId, keywordName, reportDate }))
        .returning({ id: heatmapSnapshots.id });
      insertedIds.push(row.id);
      return row.id;
    };

    const idJul13 = await seedMonthSnap(locC, "Loc C", campC1, "divorce lawyer", new Date(2026, 6, 13, 12));
    const idJul20 = await seedMonthSnap(locC, "Loc C", campC1, "divorce lawyer", new Date(2026, 6, 20, 12));
    const idJul27 = await seedMonthSnap(locC, "Loc C", campC1, "divorce lawyer", new Date(2026, 6, 27, 12));
    // Latest scan comes from the OTHER campaign mapped to locC — the collapse
    // is per (location, keyword), not per campaign.
    const idAug3 = await seedMonthSnap(locC, "Loc C", campC2, "divorce lawyer", new Date(2026, 7, 3, 12));
    const idCustody = await seedMonthSnap(locC, "Loc C", campC1, "child custody lawyer", new Date(2026, 6, 15, 12));
    // Out of window on both sides.
    const idJun20 = await seedMonthSnap(locC, "Loc C", campC1, "divorce lawyer", new Date(2026, 5, 20, 12));
    const idAug5 = await seedMonthSnap(locC, "Loc C", campC1, "divorce lawyer", new Date(2026, 7, 5, 12));
    // Ghost: campD is mapped to locD, NOT locC — and this row is NEWER than
    // the legit Aug 3 winner, so if the service marked its keyword as seen
    // before the campaign-mapping filter, the winner would be dropped.
    const idGhost = await seedMonthSnap(locC, "Loc C", campD, "divorce lawyer", new Date(2026, 7, 3, 18));
    // Same keyword at ANOTHER location keeps its own snapshot.
    const idDLocD = await seedMonthSnap(locD, "Loc D", campD, "divorce lawyer", new Date(2026, 6, 22, 12));

    const monthResult = await getSnapshotIdsForReportMonth(monthClientId, "2026-07");
    const locCIds = monthResult[locC] ?? [];
    const locDIds = monthResult[locD] ?? [];

    check(
      "locC returns exactly one id per distinct keyword, latest-first",
      locCIds.length === 2 && locCIds[0] === idAug3 && locCIds[1] === idCustody,
      `got ${JSON.stringify(locCIds)}; want [${idAug3} (divorce, Aug 3 cross-campaign), ${idCustody} (custody)]`,
    );
    check(
      "weekly duplicates collapse to the latest in-window scan",
      !locCIds.includes(idJul13) && !locCIds.includes(idJul20) && !locCIds.includes(idJul27),
      `Jul 13/20/27 scans must be skipped, got ${JSON.stringify(locCIds)}`,
    );
    const allIds = Object.values(monthResult).flat();
    check(
      "out-of-window rows stay excluded",
      !allIds.includes(idJun20) && !allIds.includes(idAug5),
      `Jun 20 (before) and Aug 5 (past grace) must not appear, got ${JSON.stringify(monthResult)}`,
    );
    check(
      "unmapped-campaign row is ignored AND does not shadow the real winner",
      !allIds.includes(idGhost),
      `ghost row ${idGhost} must not be selected, got ${JSON.stringify(monthResult)}`,
    );
    check(
      "same keyword at another location keeps its own snapshot",
      locDIds.length === 1 && locDIds[0] === idDLocD,
      `got ${JSON.stringify(locDIds)}`,
    );
  } finally {
    // Delete our non-canonical rows BEFORE restoring the constraint so the
    // re-add never trips over them.
    if (insertedIds.length > 0) {
      await db.delete(heatmapSnapshots).where(inArray(heatmapSnapshots.id, insertedIds));
    }
    await db.delete(semrushLocationCampaigns).where(eq(semrushLocationCampaigns.clientId, clientId));
    await db.delete(clientLocations).where(eq(clientLocations.clientId, clientId));
    await db.delete(clients).where(eq(clients.id, clientId));
    if (monthClientId) {
      await db.delete(semrushLocationCampaigns).where(eq(semrushLocationCampaigns.clientId, monthClientId));
      await db.delete(clientLocations).where(eq(clientLocations.clientId, monthClientId));
      await db.delete(clients).where(eq(clients.id, monthClientId));
    }
    await restoreKeywordCanonicalCheck();
    restoreStubs();
  }

  // Close undici keep-alive sockets so the loop drains (run-all scores a hang
  // as a SIGKILL FAIL).
  try {
    const undici = await import("undici");
    await undici.getGlobalDispatcher().close();
  } catch {
    /* best-effort */
  }
  await closeDbPools();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
