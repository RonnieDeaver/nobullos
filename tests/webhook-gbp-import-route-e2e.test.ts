/* test-registration
{
  "name": "Webhook import route keeps foreign GBP locations out end-to-end (Task #2614)",
  "regression": true,
  "sweepOnlyReason": "Task #2614 — full HTTP route e2e; uses real db + runInIsolatedSchema writes (DB-heavy), so not a smoke-gate candidate. Recorded during the #2615 rebase to satisfy the #2616 guard.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/parseReportPdfSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2614 — End-to-end coverage of the FULL `system:pdf-webhook` import
 * route (`POST /api/webhooks/report-import`) for the foreign-location guard.
 *
 * Task #2595 already proved the EXTRACTED pure helper
 * (`buildWebhookGbpLocationsPayload`) excludes unresolved foreign locations
 * and collects them as `unresolved` — but as a unit, in isolation. Nothing
 * proved the WIRED-UP route actually:
 *   1. survives the Active-Products gate without dropping GBP,
 *   2. resolves parsed PDF location names against the client's real Command
 *      Panel locations via the shared parenthetical-aware matcher, and
 *   3. PERSISTS the resolved rows under `marketing.gbp.locations` while the
 *      foreign ones land under `marketing.gbpUnresolvedImports`.
 *
 * A future change to the ROUTE (not the helper) — e.g. dropping the
 * `gbpUnresolvedImports` spread, mis-wiring the persist block, or regressing
 * the Active-Products filter — could still re-introduce the Lansing/Waverly
 * ghost on a Lehi/Las Vegas client. This test drives the real HTTP route,
 * parses a (stubbed) PDF, resolves against seeded Command Panel locations,
 * and reads the persisted `report_sections` row back to assert the contract.
 *
 * Harness mirrors `tests/import-common-issues-formatting.test.ts`:
 *   - `parseReportPdf` is statically imported by the route, so it is redirected
 *     to a configurable stub via the resolve hook registered through
 *     `--import ./tests/helpers/parseReportPdfSetup.mjs` (see run-all.ts).
 *   - The OpenAI singleton is mocked to throw so the Common Issues formatter
 *     uses its deterministic fallback (no network); GBP resolution is wholly
 *     independent of it.
 *   - All DB writes run inside `runInIsolatedSchema(..., { pinGetDbForCrossAsync })`
 *     so the live `Start application` workers cannot see or race the rows. The
 *     route's import-log row goes through the BARE `db` import (public schema)
 *     and is cleaned up in a `finally`.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { db } from "../server/db";
import { registerReportRoutes } from "../server/routes/reports";
import { openai } from "../server/routes/middleware";
import { runInIsolatedSchema, sql } from "./db-sandbox";
// Imported via the redirected specifier so the test configures the SAME stub
// singleton the webhook route resolves to through the resolve hook.
import {
  __setParseReportPdf,
  __resetParseReportPdf,
} from "../server/services/pdfImportParser";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-2614-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `${TAG}-actor`;
const CLIENT_ID = `${TAG}-client`;
const CP_LEHI = `${TAG}-cp-lehi`;
const CP_LV = `${TAG}-cp-lv`;
const REPORT_MONTH = "2026-05";

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

/**
 * Force the Common Issues formatter down its deterministic fallback so the
 * route never makes a real OpenAI call. GBP resolution does not depend on it.
 */
function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("simulated AI outage (task-2614)");
  };
}

function restoreOpenAi(): void {
  (openai.chat.completions as any).create = ORIGINAL_CREATE;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. This suite only hits the webhook route
    // (x-webhook-secret auth, not requireAuth), so the seam is inert here, but
    // it keeps the harness on the Clerk-era shape.
    (req as any).__test_clerkUserId = ACTOR_ID;
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

function webhookHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // In NODE_ENV=test with no secret configured the route warns and proceeds
  // (it only hard-fails in production). Sending these is harmless when unset.
  if (process.env.CEO_TOOLS_API_TOKEN) {
    headers["authorization"] = `Bearer ${process.env.CEO_TOOLS_API_TOKEN}`;
  }
  if (process.env.WEBHOOK_SECRET) {
    headers["x-webhook-secret"] = process.env.WEBHOOK_SECRET;
  }
  return headers;
}

function webhookBody(): Record<string, unknown> {
  const pdf = Buffer.from("%PDF-1.4 task-2614 synthetic pdf").toString("base64");
  return { clientId: CLIENT_ID, reportMonth: REPORT_MONTH, pdf };
}

async function readSectionData(isoDb: any, reportId: string, sectionKey: string): Promise<any> {
  const rows: any = await isoDb.execute(sql`
    SELECT data FROM report_sections
    WHERE report_id = ${reportId} AND section_key = ${sectionKey}
    LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  return list?.[0]?.data;
}

async function readMarketingData(isoDb: any, reportId: string): Promise<any> {
  return readSectionData(isoDb, reportId, "marketing");
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${ACTOR_ID}, 'ceo', ${`${ACTOR_ID}@example.com`}, 'Gbp', 'Tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // products explicitly includes 'gbp' so the Active-Products gate keeps the
  // parsed GBP locations instead of stripping the whole platform block.
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products)
    VALUES (${CLIENT_ID}, ${"Trusted Estate Planning Attorneys"}, ARRAY['gbp']::text[])
    ON CONFLICT (id) DO NOTHING
  `);
  // Firm-qualified Command Panel locations using the established "Firm (City)"
  // naming convention. The parsed short city names ("Lehi"/"Las Vegas") must
  // resolve to these through the shared parenthetical-aware matcher.
  await isoDb.execute(sql`
    INSERT INTO client_locations (id, client_id, name)
    VALUES (${CP_LEHI}, ${CLIENT_ID}, ${"Trusted Estate Planning Attorneys (Lehi)"})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO client_locations (id, client_id, name)
    VALUES (${CP_LV}, ${CLIENT_ID}, ${"Trusted Estate Planning Attorneys (Las Vegas)"})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        mockOpenAiThrows();

        // Parsed PDF carries two resolvable cities (Lehi / Las Vegas) plus two
        // foreign ones (Lansing / Waverly) belonging to NO command-panel
        // location — the exact wrong-source-PDF shape that produced the bad
        // Trusted Estate report.
        __setParseReportPdf(async () => ({
          // Task #3772 — one intake metric parsed WITH evidence (the newer
          // "Time to Human Answer" label shape), everything else absent, so
          // the persisted sections must carry noDataFlags: false for the
          // parsed metric and true for every unparsed entry-tracked metric.
          intake: { commonIssues: "", avgTimeToAnswer: 8.45 },
          sales: { commonIssues: "" },
          fieldConfidence: {
            "intake.avgTimeToAnswer": { confidence: "high", source: "Time to Human Answer: 8.45" },
          },
          marketing: {
            totalLeads: 30,
            gbpLocations: [
              { name: "Lehi", uniqueLeads: 10, reviewsGenerated: 3 },
              { name: "Las Vegas", uniqueLeads: 7, reviewsGenerated: 2 },
              { name: "Lansing", uniqueLeads: 12, reviewsGenerated: 1 },
              { name: "Waverly", uniqueLeads: 8, reviewsGenerated: 4 },
            ],
          },
        }));

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          const res = await fetch(`${baseUrl}/api/webhooks/report-import`, {
            method: "POST",
            headers: webhookHeaders(),
            body: JSON.stringify(webhookBody()),
          });
          const body: any = await res.json().catch(() => ({}));
          assert.equal(
            res.status,
            201,
            `webhook: expected 201, got ${res.status} body=${JSON.stringify(body)}`,
          );
          const reportId = body.reportId as string;
          assert.ok(reportId, "webhook response must carry reportId");

          const marketing = await readMarketingData(isoDb, reportId);
          assert.ok(marketing, "persisted marketing section must exist");

          // ── Resolved locations persisted under marketing.gbp.locations ──
          const persisted: any[] = marketing?.gbp?.locations ?? [];
          assert.equal(
            persisted.length,
            2,
            `expected 2 resolved persisted locations, got ${persisted.length}: ${JSON.stringify(persisted.map((l) => l.name))}`,
          );
          const byId = new Map(persisted.map((l) => [l.id, l]));
          assert.ok(byId.has(CP_LEHI), "resolved Lehi row must use the command-panel id");
          assert.ok(byId.has(CP_LV), "resolved Las Vegas row must use the command-panel id");
          assert.equal(byId.get(CP_LEHI).name, "Lehi", "Lehi row keeps the parsed name");
          assert.equal(byId.get(CP_LEHI).uniqueLeads, 10, "Lehi row carries parsed metrics");
          assert.equal(byId.get(CP_LV).uniqueLeads, 7, "Las Vegas row carries parsed metrics");

          // ── Foreign cities must NEVER appear in the persisted GBP rows ──
          assert.ok(
            !persisted.some((l) => l.name === "Lansing" || l.name === "Waverly"),
            "foreign cities must NOT be persisted under marketing.gbp.locations",
          );
          // ...and must NEVER have been minted a fresh confident id.
          assert.ok(
            !persisted.some((l) => l.id !== CP_LEHI && l.id !== CP_LV),
            "no persisted GBP row may use a non-command-panel (freshly minted) id",
          );

          // ── Foreign cities surfaced under marketing.gbpUnresolvedImports ──
          const unresolved: any[] = marketing?.gbpUnresolvedImports ?? [];
          assert.equal(
            unresolved.length,
            2,
            `expected 2 unresolved imports, got ${unresolved.length}: ${JSON.stringify(unresolved.map((u) => u.name))}`,
          );
          const names = unresolved.map((u) => u.name).sort();
          assert.deepEqual(
            names,
            ["Lansing", "Waverly"],
            `unresolved imports should be Lansing + Waverly, got ${names.join(",")}`,
          );
          // Metrics preserved so the operator loses no data before review.
          const lansing = unresolved.find((u) => u.name === "Lansing");
          assert.ok(lansing, "Lansing must be present in gbpUnresolvedImports");
          assert.equal(lansing.uniqueLeads, 12, "Lansing unresolved row preserves uniqueLeads");
          assert.equal(lansing.reviewsGenerated, 1, "Lansing unresolved row preserves reviewsGenerated");

          // ── Task #3772 — absent stays absent on the webhook import ──
          // The parsed payload carried evidence ONLY for intake.avgTimeToAnswer.
          // The persisted intake/sales sections must flag every OTHER
          // entry-tracked metric No-Data instead of stamping unflagged 0s.
          const intake = await readSectionData(isoDb, reportId, "intake");
          assert.ok(intake, "persisted intake section must exist");
          assert.equal(intake.avgTimeToAnswer, 8.45, "parsed avgTimeToAnswer value persists");
          assert.deepEqual(
            intake.noDataFlags,
            { totalConsults: true, avgTimeToAnswer: false, qualityScore: true },
            `intake noDataFlags must flag exactly the unparsed metrics, got ${JSON.stringify(intake.noDataFlags)}`,
          );

          const sales = await readSectionData(isoDb, reportId, "sales");
          assert.ok(sales, "persisted sales section must exist");
          assert.deepEqual(
            sales.noDataFlags,
            {
              totalCases: true,
              averageCaseValue: true,
              noShowRate: true,
              avgFollowUps: true,
              qualityScore: true,
              dealTouchDensity: true,
              avgAgeOpenMatters: true,
              pipelineMomentumScore: true,
            },
            `sales noDataFlags must flag all unparsed metrics, got ${JSON.stringify(sales.noDataFlags)}`,
          );
        } finally {
          await closeServer(server);
        }
      },
      {
        tables: [
          "users",
          "clients",
          "command_panels",
          "client_locations",
          "reports",
          "report_sections",
          "report_section_history",
        ],
        pinGetDbForCrossAsync: true,
      },
    );

    console.log("webhook-gbp-import-route-e2e: PASSED");
  } finally {
    restoreOpenAi();
    __resetParseReportPdf();
    // The webhook route writes its import-log row through the BARE `db` import
    // (public schema, ignores the isolated-schema pin). Clean it up.
    await db
      .execute(sql`DELETE FROM webhook_import_logs WHERE client_id = ${CLIENT_ID}`)
      .catch(() => undefined);
    // Close undici keep-alive sockets so the process drains naturally instead
    // of hanging on exit.
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("webhook-gbp-import-route-e2e: FAILED", err);
    process.exitCode = 1;
  });
