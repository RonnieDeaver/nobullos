/* test-registration
{
  "name": "Privacy mode masks locations, keywords and competitors on public shares (Task #4290)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4290: privacy-mode shares masked ONLY the firm name and leaked identifying geography — GBP location names, heatmap keyword phrases (which embed city names), competitor firm names, the client's blog URL, baked heatmap screenshots, and free-text city mentions in common issues / slide verdicts. This is the route-level tripwire on the real /api/share builder + serve-time masker: a regression here re-identifies the client on every privacy share. Real route + hermetic DB, 3 fetches, fast.",
  "tier": "small"
}
test-registration */
/**
 * Task #4290 — privacy-mode location masking on the public share endpoint.
 *
 * Pins, against the REAL route (GET /api/share/:token → buildReportResponse →
 * maskReportPayloadForPrivacy):
 *
 *   1. Control (no privacy): every seeded identifier is served verbatim,
 *      privacyApplied === false, and nothing structural is dropped — the
 *      masker must be a no-op outside privacy mode.
 *   2. ?private=true (DB flag OFF): the serialized payload contains NO seeded
 *      identifier anywhere (case-insensitive sweep), and the canonical fields
 *      carry deterministic labels: locations "Market A"/"Market B" in stored
 *      order, keywords "Keyword A"/"Keyword B", competitors "Competitor A"/
 *      "Competitor B", subject-business rows "Confidential Client",
 *      locationLabel nulled, heatmapImageUrl + blogPostUrl dropped, snapshot
 *      UUIDs preserved (the interactive map needs them), and free text in
 *      intake commonIssues / slide verdicts scrubbed to the same labels.
 *   3. DB privacy_mode=true (no query param): identical masking.
 *
 * The masked-label determinism matters: every slide that names the same
 * location must show the same "Market X" so the deck stays readable.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerReportRoutes } from "../server/routes/reports";

const SUF = `t4290${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const CLIENT_ID = `${SUF}-client`;
const REPORT_ID = `${SUF}-report`;
const SHARE_TOKEN = `${SUF}-share-token`;

// Identifying strings — every one must vanish under privacy mode. The unique
// suffix keeps them collision-proof on the shared-style seed tables AND makes
// the "must not appear" sweep exact.
const CITY = `Rivergate${SUF}`;
const CITY_LOWER = CITY.toLowerCase();
const FIRM = `Blackstone${SUF} Injury Law`;
const CONTACT = `Marcus Vantage${SUF}`;
const LOC1 = `${CITY} North Office`;
const LOC2 = `${CITY} South Office`;
const KW1 = `${CITY_LOWER} car accident lawyer`;
const KW2 = `personal injury attorney ${CITY_LOWER}`;
const COMP1 = `Sterling${SUF} & Associates`;
const COMP2 = `Harborview${SUF} Legal Group`;
const BLOG = `https://www.blackstone${SUF}law.com/blog/spring-update`;
const IMG = `https://storage.example.com/heatmaps/${SUF}/map.png`;
const SNAP1 = randomUUID();
const SNAP2 = randomUUID();

/** Every string that identifies the client or their geography. */
const IDENTIFIERS = [CITY, FIRM, CONTACT, LOC1, LOC2, KW1, KW2, COMP1, COMP2, BLOG, IMG];

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
  await db.execute(sql`DELETE FROM report_sections WHERE report_id = ${REPORT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM reports WHERE id = ${REPORT_ID}`).catch(() => 0);
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`).catch(() => 0);
}

const distributionBands = { top3: 40, top10: 30, top20: 20, beyond: 10 };

// NOTE: every keywordSnapshot carries the `distributionBands` KEY — the serve
// path's lazy dominance upgrade (Task #2703) only rehydrates snapshots
// MISSING that key, so these stored fixtures are served verbatim.
const marketingData = {
  gbp: {
    locations: [
      {
        name: LOC1,
        uniqueLeads: 12,
        reviewsGenerated: 4,
        reviewsRespondedTo: 3,
        postsQaCount: 2,
        heatmapImageUrl: IMG,
        heatmapSnapshotIds: [SNAP1],
        localDominance: {
          sovHistory: [{ month: "2026-06", shareOfVoice: 38 }],
          distributionBands,
          competitors: [
            { rank: 1, name: COMP1, shareOfVoice: 41, averageRank: 2.2, isSubjectBusiness: false, locationLabel: `${CITY} North` },
            { rank: 2, name: FIRM, shareOfVoice: 33, averageRank: 3.1, isSubjectBusiness: true },
          ],
          keywordSnapshots: [
            {
              keywordName: KW1,
              snapshotId: SNAP1,
              reportDate: "2026-07-15",
              shareOfVoice: 41,
              avgRank: 2.5,
              previousAvgRank: 3.2,
              rankChange: 0.7,
              sovChange: 5,
              distributionBands,
              competitors: [
                { rank: 1, name: COMP1, shareOfVoice: 41, averageRank: 2.2, isSubjectBusiness: false, locationLabel: `${CITY} North` },
                { rank: 2, name: FIRM, shareOfVoice: 33, averageRank: 3.1, isSubjectBusiness: true },
              ],
              sovHistory: [{ month: "2026-06", shareOfVoice: 38 }],
            },
          ],
        },
      },
      {
        name: LOC2,
        uniqueLeads: 7,
        reviewsGenerated: 1,
        reviewsRespondedTo: 1,
        postsQaCount: 1,
        heatmapSnapshotIds: [SNAP2],
        localDominance: {
          sovHistory: [],
          distributionBands: null,
          competitors: [
            { rank: 1, name: COMP2, shareOfVoice: 39, averageRank: 2.9, isSubjectBusiness: false },
          ],
          keywordSnapshots: [
            {
              keywordName: KW2,
              snapshotId: SNAP2,
              reportDate: "2026-07-15",
              shareOfVoice: 28,
              avgRank: 4.1,
              previousAvgRank: 4.4,
              rankChange: 0.3,
              sovChange: 2,
              distributionBands: null,
              competitors: [],
              sovHistory: [],
            },
          ],
        },
      },
    ],
    shared: { blogPostUrl: BLOG },
  },
};

const intakeData = {
  commonIssues: `Callers from ${CITY} keep mentioning ${FIRM} and ${COMP1} in reviews.`,
};

const slideVerdictsData = {
  verdicts: {
    marketing: `Map rankings across ${CITY} improved this month for ${FIRM}.`,
  },
};

async function seed(): Promise<void> {
  // No command_panels row on purpose: active-products resolution falls back
  // to clients.products (defaults to ARRAY['gbp']), keeping the gbp block
  // alive through applyActiveProductsFilter without touching shared CP state.
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, contact_name)
    VALUES (${CLIENT_ID}, ${FIRM}, ${CONTACT})
  `);
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, share_token, privacy_mode)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, '2026-07', 'final', ${SHARE_TOKEN}, false)
  `);
  await db.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES
      (${REPORT_ID}, 'marketing', ${JSON.stringify(marketingData)}::jsonb),
      (${REPORT_ID}, 'intake', ${JSON.stringify(intakeData)}::jsonb),
      (${REPORT_ID}, 'slideVerdicts', ${JSON.stringify(slideVerdictsData)}::jsonb)
  `);
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Anonymous public-share consumer — no auth (Clerk test seam:
    // null = explicit-unauthenticated).
    (req as any).__test_clerkUserId = null;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchSharePayload(baseUrl: string, query = ""): Promise<any> {
  const r = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}${query}`);
  ok(r.status === 200, `GET /api/share/:token${query} → 200 (got ${r.status})`);
  return r.json();
}

function marketingSectionOf(body: any): any {
  return (body?.sections ?? []).find((s: any) => s?.sectionKey === "marketing")?.data;
}

function assertFullyMasked(body: any, label: string): void {
  const text = JSON.stringify(body).toLowerCase();
  for (const ident of IDENTIFIERS) {
    ok(!text.includes(ident.toLowerCase()), `${label}: payload contains no "${ident}"`);
  }
  ok(body?.report?.privacyApplied === true, `${label}: report.privacyApplied === true`);
  ok(body?.client?.firmName === "Confidential Client", `${label}: client.firmName masked`);

  const md = marketingSectionOf(body);
  const locs = md?.gbp?.locations ?? [];
  ok(locs.length === 2, `${label}: both gbp locations survive (got ${locs.length})`);
  ok(locs[0]?.name === "Market A", `${label}: first location → "Market A" (got ${JSON.stringify(locs[0]?.name)})`);
  ok(locs[1]?.name === "Market B", `${label}: second location → "Market B" (got ${JSON.stringify(locs[1]?.name)})`);
  ok(!("heatmapImageUrl" in (locs[0] ?? {})), `${label}: heatmapImageUrl dropped`);
  ok(locs[0]?.heatmapSnapshotIds?.[0] === SNAP1, `${label}: snapshot UUID untouched (map still renders)`);
  ok(md?.gbp?.shared?.blogPostUrl === undefined, `${label}: blogPostUrl dropped`);

  const kwA = locs[0]?.localDominance?.keywordSnapshots?.[0];
  const kwB = locs[1]?.localDominance?.keywordSnapshots?.[0];
  ok(kwA?.keywordName === "Keyword A", `${label}: first keyword → "Keyword A" (got ${JSON.stringify(kwA?.keywordName)})`);
  ok(kwB?.keywordName === "Keyword B", `${label}: second keyword → "Keyword B" (got ${JSON.stringify(kwB?.keywordName)})`);

  const comps = kwA?.competitors ?? [];
  const rival = comps.find((c: any) => c?.isSubjectBusiness !== true);
  const subject = comps.find((c: any) => c?.isSubjectBusiness === true);
  ok(rival?.name === "Competitor A", `${label}: competitor → "Competitor A" (got ${JSON.stringify(rival?.name)})`);
  ok(rival?.locationLabel === null, `${label}: competitor locationLabel nulled (got ${JSON.stringify(rival?.locationLabel)})`);
  ok(subject?.name === "Confidential Client", `${label}: subject-business row → "Confidential Client" (got ${JSON.stringify(subject?.name)})`);
  const compB = locs[1]?.localDominance?.competitors?.[0];
  ok(compB?.name === "Competitor B", `${label}: second competitor → "Competitor B" (got ${JSON.stringify(compB?.name)})`);

  // Free-text scrub: intake commonIssues + slide verdicts mention the city
  // token and the firm — both must resolve to the SAME deterministic labels.
  const intake = (body?.sections ?? []).find((s: any) => s?.sectionKey === "intake")?.data;
  const intakeText = JSON.stringify(intake ?? {});
  ok(intakeText.includes("Market A"), `${label}: commonIssues city token → "Market A"`);
  ok(intakeText.includes("Confidential Client"), `${label}: commonIssues firm mention → "Confidential Client"`);
  ok(intakeText.includes("Competitor A"), `${label}: commonIssues competitor mention → "Competitor A"`);

  const verdict = body?.slideVerdicts?.marketing;
  ok(typeof verdict === "string" && verdict.includes("Market A"), `${label}: slide verdict city → "Market A" (got ${JSON.stringify(verdict)})`);
}

async function run(): Promise<void> {
  await cleanup();
  await seed();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // 1. Control — no privacy: masker must be a byte-level no-op.
    {
      const body = await fetchSharePayload(baseUrl);
      const text = JSON.stringify(body);
      ok(body?.report?.privacyApplied === false, `control: privacyApplied === false (got ${JSON.stringify(body?.report?.privacyApplied)})`);
      ok(body?.client?.firmName === FIRM, "control: real firm name served");
      const md = marketingSectionOf(body);
      ok(md?.gbp?.locations?.[0]?.name === LOC1, "control: real location name served");
      ok(md?.gbp?.locations?.[0]?.heatmapImageUrl === IMG, "control: heatmapImageUrl kept");
      ok(md?.gbp?.shared?.blogPostUrl === BLOG, "control: blogPostUrl kept");
      ok(text.includes(KW1), "control: real keyword served");
      ok(text.includes(COMP1), "control: real competitor served");
      ok(text.includes(CITY), "control: free-text city mention kept");
    }

    // 2. ?private=true with the DB flag OFF — the query-param view must mask
    //    exactly like a stored privacy report (this is the historic leak:
    //    the flag was applied to the firm name only).
    {
      const body = await fetchSharePayload(baseUrl, "?private=true");
      assertFullyMasked(body, "?private=true");
      ok(body?.report?.privacyMode === false, "?private=true: stored privacyMode still reported false");
    }

    // 3. DB privacy_mode=true, no query param.
    {
      await db.execute(sql`UPDATE reports SET privacy_mode = true WHERE id = ${REPORT_ID}`);
      const body = await fetchSharePayload(baseUrl);
      assertFullyMasked(body, "privacy_mode=true");
      ok(body?.report?.privacyMode === true, "privacy_mode=true: stored flag reported true");
    }
  } finally {
    await closeServer(server);
    // Route tests that fetch a local express server can hang on exit via
    // undici's keep-alive sockets — close the global dispatcher.
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

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
run().then(
  () => {},
  async (err) => {
    console.error("Test threw:", err);
    await cleanup().catch(() => 0);
    process.exitCode = 1;
  },
);
