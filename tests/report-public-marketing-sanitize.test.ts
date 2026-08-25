/* test-registration
{
  "name": "Public marketing payload sanitization — share + demo (Task #4280)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4280 (audit §8.7-7 + §8.5): the Marketing slide restructure removed internal operator state from the anonymous client surface, and this suite is the only server-side lock on that privacy boundary. GBP locations served on /api/share/:token AND /api/demo-report must project through the explicit field allowlist (place ids, automation state, ops notes and any other operator-lifecycle keys never reach an anonymous viewer), the marketing section must not carry gbpUnresolvedImports or the broken-source import warning, and safeClient must not carry the retired review-automation flags. A drift here silently ships internal ops state to paying clients and prospects.",
  "tier": "small"
}
test-registration */
/**
 * Task #4280 — serve-time sanitization of the public marketing section.
 *
 * `sanitizePublicMarketingSectionData` (server/routes/reports.ts) is shared by
 * BOTH public payload builders — `buildReportResponse` (share/preview) and the
 * `/api/demo-report` twin — so the two lanes are asserted against the same
 * expectations here:
 *
 *   1. GBP locations (BOTH stored shapes: `gbp.locations` and the top-level
 *      `gbpLocations` twin) carry ONLY the allowlisted public fields. Base
 *      keys always: name, uniqueLeads, reviewsGenerated, reviewsRespondedTo,
 *      postsQaCount, leadQuality. Conditional keys only when present:
 *      localDominance, heatmapSnapshotIds+heatmapSnapshotId, heatmapImageUrl.
 *      Internal operator keys seeded into the fixture (placeId, cid,
 *      automationState, opsNotes, sourceRowId) must never be served.
 *   2. Allowlisted values survive UNCHANGED (name/leads/localDominance/
 *      heatmap ids) — sanitization must not corrupt what the slide renders.
 *   3. Section-level internal keys are stripped: `gbpUnresolvedImports`
 *      (operator review queue) and the marketing slot of
 *      BROKEN_SOURCE_WARNING_KEY (defense-in-depth, lock-step with the
 *      intake/sales strips).
 *   4. safeClient never carries the retired automation flags
 *      (hasPostConsultReviewAccess / hasPostCaseClosedReviewAccess) — the
 *      client-surface removal in Task #4280 assumed they are server-absent.
 *
 * Harness mirrors tests/report-slide-verdicts.test.ts: express app +
 * registerReportRoutes, anonymous requests only (both routes are public),
 * runInIsolatedSchema with pinGetDbForCrossAsync. The demo route resolves the
 * report via the is_demo-client fallback lane (no demoReportId setting row in
 * the isolated schema; a stale cached id cannot resolve to a report here).
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { registerReportRoutes } from "../server/routes/reports";
import { BROKEN_SOURCE_WARNING_KEY } from "../server/services/reportImportWarnings";
import { runInIsolatedSchema, sql } from "./db-sandbox";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-4280-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OWNER_ID = `${TAG}-owner`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const SHARE_TOKEN = `${TAG}-share-token`;

// Internal operator-lifecycle keys planted on every fixture location; the
// projection must drop ALL of them on both twins and both routes.
const INTERNAL_LOC_KEYS = [
  "placeId",
  "cid",
  "automationState",
  "opsNotes",
  "sourceRowId",
] as const;

const LOC_FULL = {
  name: "Sanitize Main Office",
  uniqueLeads: 120,
  reviewsGenerated: 9,
  reviewsRespondedTo: 7,
  postsQaCount: 4,
  leadQuality: { good: 80, notQuotable: 30, missedCalls: 10, noData: 0 },
  localDominance: {
    keywordSnapshots: [
      {
        snapshotId: "hs-1",
        keywordName: "personal injury lawyer",
        avgRank: 2.4,
        rankChange: 1.2,
      },
    ],
  },
  heatmapSnapshotIds: ["hs-1"],
  heatmapSnapshotId: "hs-1",
  heatmapImageUrl: "/fake/thumb-main.png",
  placeId: "ChIJ-internal-main",
  cid: "9876543210",
  automationState: { reviewRequestsPaused: true, lastRunAt: "2026-08-01" },
  opsNotes: "call the office manager before pausing",
  sourceRowId: "import-row-77",
};

// Sparse location: none of the conditional allowlist fields → the served
// object must not even carry those keys (undefined-valued keys are dropped by
// JSON serialization, so key-set equality is meaningful).
const LOC_SPARSE = {
  name: "Sanitize Satellite",
  uniqueLeads: 15,
  reviewsGenerated: 1,
  reviewsRespondedTo: 0,
  postsQaCount: 0,
  leadQuality: { good: 5, notQuotable: 5, missedCalls: 5, noData: 0 },
  placeId: "ChIJ-internal-satellite",
  cid: "1234509876",
  automationState: { reviewRequestsPaused: false },
  opsNotes: "n/a",
  sourceRowId: "import-row-78",
};

const BASE_KEYS = [
  "leadQuality",
  "name",
  "postsQaCount",
  "reviewsGenerated",
  "reviewsRespondedTo",
  "uniqueLeads",
];
const FULL_KEYS = [
  ...BASE_KEYS,
  "heatmapImageUrl",
  "heatmapSnapshotId",
  "heatmapSnapshotIds",
  "localDominance",
].sort();

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Anonymous everywhere — both routes under test are public.
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

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${OWNER_ID}, 'ceo', ${`${OWNER_ID}@example.com`}, 'Sanitize', 'Owner')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // is_demo=true → /api/demo-report's fallback lane serves this client's
  // newest report (the only one).
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, owner_id, is_demo)
    VALUES (${CLIENT_ID}, ${"Sanitize Law (test)"}, ARRAY['gbp']::text[], ${OWNER_ID}, true)
    ON CONFLICT (id) DO NOTHING
  `);
  // product_types MUST be set: an existing command-panel row is the
  // authoritative Active-Products source (empty = "owns no products"), and
  // the public serializer's applyActiveProductsFilter would delete the whole
  // gbp block before the sanitizer under test ever ran.
  await isoDb.execute(sql`
    INSERT INTO command_panels (client_id, product_types, last_reviewed_at)
    VALUES (${CLIENT_ID}, ARRAY['gbp']::text[], now())
  `);
  // Seeded directly as 'final' — the share route only serves finalized
  // reports and this suite does not exercise the finalize gates.
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, '2026-05', 'final')
  `);
  await isoDb.execute(sql`
    UPDATE reports SET share_token = ${SHARE_TOKEN} WHERE id = ${REPORT_ID}
  `);

  // BOTH stored GBP shapes carry internal keys; section-level internal keys
  // ride alongside. The stored row is what an import/operator flow could have
  // left behind — the SERVE path must be the thing that strips it.
  const marketingData = {
    posture: "stable",
    gbp: { locations: [LOC_FULL, LOC_SPARSE] },
    gbpLocations: [{ ...LOC_FULL, name: "Sanitize Twin A" }],
    otherLeads: {
      count: 10,
      description: "",
      leadQuality: { good: 4, notQuotable: 4, missedCalls: 2, noData: 0 },
    },
    gbpUnresolvedImports: [{ name: "Ghost Office", uniqueLeads: 3 }],
    [BROKEN_SOURCE_WARNING_KEY]: "🔴 marketing source doc could not be read",
  };
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${REPORT_ID}-marketing`}, ${REPORT_ID}, 'marketing',
            ${JSON.stringify(marketingData)}::jsonb)
  `);
}

function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

function assertSanitizedMarketing(payload: any, label: string): void {
  const mkt = (payload.sections ?? []).find((s: any) => s?.sectionKey === "marketing");
  assert.ok(mkt?.data, `${label}: marketing section is served`);

  // (3) section-level internal keys stripped
  assert.ok(
    !("gbpUnresolvedImports" in mkt.data),
    `${label}: gbpUnresolvedImports stripped from the served marketing section`,
  );
  assert.ok(
    !(BROKEN_SOURCE_WARNING_KEY in mkt.data),
    `${label}: ${BROKEN_SOURCE_WARNING_KEY} stripped from the served marketing section`,
  );

  // (1)+(2) gbp.locations lane
  const locs = mkt.data?.gbp?.locations;
  assert.ok(Array.isArray(locs) && locs.length === 2, `${label}: both seeded locations served`);
  const [full, sparse] = locs;
  assert.deepEqual(
    sortedKeys(full),
    FULL_KEYS,
    `${label}: full location serves EXACTLY the allowlisted keys (incl. conditional heatmap/dominance)`,
  );
  assert.deepEqual(
    sortedKeys(sparse),
    BASE_KEYS,
    `${label}: sparse location serves EXACTLY the base allowlist (no conditional keys minted)`,
  );
  assert.equal(full.name, LOC_FULL.name, `${label}: name survives`);
  assert.equal(full.uniqueLeads, LOC_FULL.uniqueLeads, `${label}: uniqueLeads survives`);
  // The serve path re-hydrates localDominance CONTENTS from live snapshot
  // tables (empty in this isolated schema) — the sanitizer contract is that
  // the KEY survives the projection with the hydrated shape intact.
  assert.ok(
    full.localDominance &&
      typeof full.localDominance === "object" &&
      Array.isArray((full.localDominance as any).keywordSnapshots),
    `${label}: localDominance survives the projection as the hydrated dominance shape`,
  );
  assert.deepEqual(
    full.heatmapSnapshotIds,
    LOC_FULL.heatmapSnapshotIds,
    `${label}: heatmapSnapshotIds pass through unchanged (map grid reads them)`,
  );

  // (1) top-level gbpLocations twin lane
  const twin = mkt.data?.gbpLocations;
  assert.ok(Array.isArray(twin) && twin.length === 1, `${label}: gbpLocations twin served`);
  assert.deepEqual(
    sortedKeys(twin[0]),
    FULL_KEYS,
    `${label}: gbpLocations twin projects through the SAME allowlist`,
  );
  assert.equal(twin[0].name, "Sanitize Twin A", `${label}: twin name survives`);

  for (const loc of [...locs, ...twin]) {
    for (const key of INTERNAL_LOC_KEYS) {
      assert.ok(
        !(key in loc),
        `${label}: internal key "${key}" must never be served (found on "${loc?.name}")`,
      );
    }
  }

  // (4) safeClient carries no automation flags
  assert.ok(payload.client, `${label}: client object served`);
  for (const flag of ["hasPostConsultReviewAccess", "hasPostCaseClosedReviewAccess"]) {
    assert.ok(
      !(flag in payload.client),
      `${label}: safeClient must not carry the retired automation flag "${flag}"`,
    );
  }
}

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        const { server, baseUrl } = await listen(buildApp());
        try {
          const share = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
          assert.equal(share.status, 200, `share fetch: expected 200, got ${share.status}`);
          const shareBody: any = await share.json();
          assertSanitizedMarketing(shareBody, "share");

          const demo = await fetch(`${baseUrl}/api/demo-report`);
          assert.equal(demo.status, 200, `demo fetch: expected 200, got ${demo.status}`);
          const demoBody: any = await demo.json();
          assert.equal(
            demoBody.report?.id,
            REPORT_ID,
            "fixture sanity: demo fallback lane serves the seeded demo report",
          );
          assertSanitizedMarketing(demoBody, "demo");

          console.log("route: share + demo marketing sanitization PASSED");
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      {
        tables: [
          "users",
          "clients",
          "command_panels",
          "client_locations",
          "client_data_access",
          "reports",
          "report_sections",
          "report_section_history",
          "user_notifications",
          "system_settings",
          "ceo_pulses",
        ],
        pinGetDbForCrossAsync: true,
      },
    );

    console.log("report-public-marketing-sanitize: PASSED");
  } finally {
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("report-public-marketing-sanitize: FAILED", err);
    process.exitCode = 1;
  });
