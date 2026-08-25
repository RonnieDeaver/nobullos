/* test-registration
{
  "name": "Public payload internal bookkeeping-key strip — all sections, share + demo (Task #4467)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4467: same privacy boundary as the Task #4280 marketing sanitize suite, extended to every served section. Internal backfill/convergence stamps (commonIssuesReformatBackfillVersion on intake/sales, the June-2026 lead-reparse stamp pair on marketing, the broken-source warning slot) must never reach anonymous viewers on /api/share/:token or /api/demo-report. Both routes strip via ONE shared helper; a drift here silently ships internal ops bookkeeping to paying clients and prospects.",
  "tier": "small"
}
test-registration */
/**
 * Task #4467 — serve-time strip of internal bookkeeping keys from EVERY
 * section of the public report payloads.
 *
 * `stripInternalSectionBookkeepingKeys` (server/routes/reports.ts) is shared
 * by BOTH public payload builders — `buildReportResponse` (share/preview) and
 * the `/api/demo-report` twin — so both lanes are asserted against the same
 * expectations here:
 *
 *   1. intake + sales sections: `commonIssuesReformatBackfillVersion` and the
 *      BROKEN_SOURCE_WARNING_KEY slot never served.
 *   2. marketing section: the June-2026 lead-reparse stamp pair
 *      (`juneLeadReparseVersion` / `juneLeadReparseOutcome`) never served
 *      (Task #4280's allowlist covered GBP locations + gbpUnresolvedImports;
 *      these top-level stamps were still passing through).
 *   3. Legitimate client-facing values on the same sections survive
 *      unchanged (commonIssues body, funnel metrics, noDataFlags).
 *
 * Harness mirrors tests/report-public-marketing-sanitize.test.ts: express app
 * + registerReportRoutes, anonymous requests only, runInIsolatedSchema with
 * pinGetDbForCrossAsync, is_demo-client fallback lane for the demo route, and
 * the command_panels product_types seeding (an empty command-panel row would
 * make applyActiveProductsFilter delete the whole gbp block).
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { registerReportRoutes } from "../server/routes/reports";
import { BROKEN_SOURCE_WARNING_KEY } from "../server/services/reportImportWarnings";
import { REFORMAT_STAMP_KEY } from "../server/services/commonIssuesReformatBackfill";
import {
  JUNE_LEAD_REPARSE_STAMP_KEY,
  JUNE_LEAD_REPARSE_OUTCOME_KEY,
} from "../server/services/juneLeadReparse";
import { runInIsolatedSchema, sql } from "./db-sandbox";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-4467-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OWNER_ID = `${TAG}-owner`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const SHARE_TOKEN = `${TAG}-share-token`;

const INTAKE_COMMON_ISSUES =
  "🔴 **Issue:** Calls after 5pm go to voicemail\n" +
  "↳ **Impact:** Evening leads never reach a human\n" +
  "> ➡️ **Strategic Fix:** Add an after-hours answering rotation";

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
    VALUES (${OWNER_ID}, 'ceo', ${`${OWNER_ID}@example.com`}, 'Stamp', 'Owner')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // is_demo=true → /api/demo-report's fallback lane serves this client's
  // newest report (the only one).
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, owner_id, is_demo)
    VALUES (${CLIENT_ID}, ${"Stamp Strip Law (test)"}, ARRAY['gbp']::text[], ${OWNER_ID}, true)
    ON CONFLICT (id) DO NOTHING
  `);
  // product_types MUST be set (command-panel row is the authoritative
  // Active-Products source; empty would delete the whole gbp block before
  // the strip under test ever ran).
  await isoDb.execute(sql`
    INSERT INTO command_panels (client_id, product_types, last_reviewed_at)
    VALUES (${CLIENT_ID}, ARRAY['gbp']::text[], now())
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, '2026-06', 'final')
  `);
  await isoDb.execute(sql`
    UPDATE reports SET share_token = ${SHARE_TOKEN} WHERE id = ${REPORT_ID}
  `);

  // Stored rows carry exactly what a backfill/import flow could have left
  // behind — the SERVE path must be the thing that strips the stamps.
  const intakeData = {
    totalConsults: 42,
    qualityScore: 78,
    commonIssues: INTAKE_COMMON_ISSUES,
    noDataFlags: { totalConsults: false },
    [REFORMAT_STAMP_KEY]: 1,
    [BROKEN_SOURCE_WARNING_KEY]: {
      missingMetrics: ["totalConsults"],
      rawPlaceholder: false,
      priorReportMonth: "2026-05",
      source: "webhook",
      detectedAt: "2026-06-05T00:00:00.000Z",
    },
  };
  const salesData = {
    totalCases: 11,
    consultToCaseRate: 26.2,
    commonIssues: "Consult follow-up cadence stalls after the second touch.",
    noDataFlags: { totalCases: false },
    [REFORMAT_STAMP_KEY]: 1,
    [BROKEN_SOURCE_WARNING_KEY]: {
      missingMetrics: ["totalCases"],
      rawPlaceholder: false,
      priorReportMonth: "2026-05",
      source: "reimport",
      detectedAt: "2026-06-05T00:00:00.000Z",
    },
  };
  const marketingData = {
    posture: "stable",
    totalLeads: 90,
    gbp: {
      locations: [
        {
          name: "Stamp Main Office",
          uniqueLeads: 90,
          reviewsGenerated: 5,
          reviewsRespondedTo: 4,
          postsQaCount: 2,
          leadQuality: { good: 60, notQuotable: 20, missedCalls: 10, noData: 0 },
        },
      ],
    },
    [JUNE_LEAD_REPARSE_STAMP_KEY]: 1,
    [JUNE_LEAD_REPARSE_OUTCOME_KEY]: "unchanged",
  };
  for (const [key, data] of [
    ["intake", intakeData],
    ["sales", salesData],
    ["marketing", marketingData],
  ] as const) {
    await isoDb.execute(sql`
      INSERT INTO report_sections (id, report_id, section_key, data)
      VALUES (${`${REPORT_ID}-${key}`}, ${REPORT_ID}, ${key},
              ${JSON.stringify(data)}::jsonb)
    `);
  }
}

const STRIPPED_KEYS = [
  REFORMAT_STAMP_KEY,
  JUNE_LEAD_REPARSE_STAMP_KEY,
  JUNE_LEAD_REPARSE_OUTCOME_KEY,
  BROKEN_SOURCE_WARNING_KEY,
  "gbpUnresolvedImports",
] as const;

function assertStripped(payload: any, label: string): void {
  const sections: any[] = payload.sections ?? [];
  for (const key of ["intake", "sales", "marketing"]) {
    const section = sections.find((s) => s?.sectionKey === key);
    assert.ok(section?.data, `${label}: ${key} section is served`);
    for (const stripped of STRIPPED_KEYS) {
      assert.ok(
        !(stripped in section.data),
        `${label}: internal key "${stripped}" must never be served on the ${key} section`,
      );
    }
  }

  // Legitimate client-facing values survive unchanged.
  const intake = sections.find((s) => s?.sectionKey === "intake")!.data;
  assert.equal(intake.totalConsults, 42, `${label}: intake.totalConsults survives`);
  assert.equal(intake.commonIssues, INTAKE_COMMON_ISSUES, `${label}: intake commonIssues body survives`);
  assert.deepEqual(
    intake.noDataFlags,
    { totalConsults: false },
    `${label}: intake noDataFlags (entry-tracking era marker) survives`,
  );
  const sales = sections.find((s) => s?.sectionKey === "sales")!.data;
  assert.equal(sales.totalCases, 11, `${label}: sales.totalCases survives`);
  const mkt = sections.find((s) => s?.sectionKey === "marketing")!.data;
  assert.equal(mkt.totalLeads, 90, `${label}: marketing.totalLeads survives`);
  assert.equal(
    mkt.gbp?.locations?.[0]?.name,
    "Stamp Main Office",
    `${label}: GBP location survives the marketing allowlist alongside the stamp strip`,
  );
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
          assertStripped(await share.json(), "share");

          const demo = await fetch(`${baseUrl}/api/demo-report`);
          assert.equal(demo.status, 200, `demo fetch: expected 200, got ${demo.status}`);
          const demoBody: any = await demo.json();
          assert.equal(
            demoBody.report?.id,
            REPORT_ID,
            "fixture sanity: demo fallback lane serves the seeded demo report",
          );
          assertStripped(demoBody, "demo");

          console.log("route: share + demo internal-key strip PASSED");
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

    console.log("report-public-internal-keys-sanitize: PASSED");
  } finally {
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("report-public-internal-keys-sanitize: FAILED", err);
    process.exitCode = 1;
  });
