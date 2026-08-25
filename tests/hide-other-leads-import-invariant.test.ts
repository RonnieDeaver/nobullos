/* test-registration
{
  "name": "Hide Other leads — webhook import persists raw total; public read injects flag (Task #2760)",
  "regression": true,
  "sweepOnlyReason": "Task #2760 — full HTTP route e2e (webhook import + public share read); real db + runInIsolatedSchema writes (DB-heavy), so not a smoke-gate candidate. Mirrors the #2614 peer entry.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/parseReportPdfSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2760 — PDF webhook re-import vs the live public report for a
 * hideOtherLeads-enabled client.
 *
 * The invariant under guard (documented at the webhook persist block in
 * `server/routes/reports.ts`):
 *
 *   1. The webhook import persists `marketing.totalLeads` RAW — INCLUDING the
 *      Other bucket — even when the client's `hideOtherLeads` flag is ON.
 *      Operators need the full picture in the admin editor.
 *   2. The public report endpoint (`GET /api/share/:token`) injects
 *      `client.hideOtherLeads = true` so the RENDERER subtracts Other at
 *      display time (`adjustDisplayLeads` / PublicReport zeroing) — the
 *      subtraction must NEVER happen at persist time, or a later display-time
 *      subtraction would double-subtract.
 *   3. The ONLY persist-time application of hideOtherLeads is the
 *      missedCallRate (Task #2680): numerator and denominator adjusted
 *      symmetrically, because the rate is stored as a final percentage.
 *
 * Harness mirrors `tests/webhook-gbp-import-route-e2e.test.ts`:
 *   - `parseReportPdf` is redirected to a configurable stub via the resolve
 *     hook registered through `--import ./tests/helpers/parseReportPdfSetup.mjs`.
 *   - The OpenAI singleton is mocked to throw so Common Issues formatting uses
 *     its deterministic fallback (no network).
 *   - All DB writes run inside `runInIsolatedSchema(..., { pinGetDbForCrossAsync })`.
 *     The route's import-log row goes through the BARE `db` import (public
 *     schema) and is cleaned up in a `finally`.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

// Ensure the Clerk per-request test seam is active for bare repros too.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db } from "../server/db";
import { registerReportRoutes } from "../server/routes/reports";
import { openai } from "../server/routes/middleware";
import { adjustDisplayLeads } from "../shared/missedCallRate";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { runInIsolatedSchema, sql } from "./db-sandbox";
// Imported via the redirected specifier so the test configures the SAME stub
// singleton the webhook route resolves to through the resolve hook.
import {
  __setParseReportPdf,
  __resetParseReportPdf,
} from "../server/services/pdfImportParser";

const TAG = `task-2760-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `${TAG}-actor`;
const CLIENT_ID = `${TAG}-client`;
const CP_LEHI = `${TAG}-cp-lehi`;
const REPORT_MONTH = "2026-06";
const SHARE_TOKEN = `${TAG}-share`;

// ── Scenario numbers ────────────────────────────────────────────────────────
// Raw total INCLUDES the Other bucket. GBP is the only active product.
const RAW_TOTAL_LEADS = 100; // parsed grand total (60 GBP + 40 Other)
const OTHER_COUNT = 40;
const OTHER_MISSED = 10;
const GBP_MISSED = 12;
// Persist-time missedCallRate (Task #2680): hide ON removes Other from BOTH
// sides → (12 + 10 − 10) / (100 − 40) = 12/60 = 20.0%.
const EXPECTED_MISSED_CALL_RATE = 20;

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("simulated AI outage (task-2760)");
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
    // authenticates as that user id. ACTOR_ID is seeded only in the isolated
    // schema, so it is also pre-registered in the requireAuth test registry
    // (after seed) — requireAuth uses the profile directly and populates
    // req.user.claims.sub.
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
  if (process.env.CEO_TOOLS_API_TOKEN) {
    headers["authorization"] = `Bearer ${process.env.CEO_TOOLS_API_TOKEN}`;
  }
  if (process.env.WEBHOOK_SECRET) {
    headers["x-webhook-secret"] = process.env.WEBHOOK_SECRET;
  }
  return headers;
}

function webhookBody(): Record<string, unknown> {
  const pdf = Buffer.from("%PDF-1.4 task-2760 synthetic pdf").toString("base64");
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

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${ACTOR_ID}, 'ceo', ${`${ACTOR_ID}@example.com`}, 'HideOther', 'Tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // Users are seeded in the isolated schema (not in public), so requireAuth's
  // ambient public-schema lookup would miss and JIT-provision. Pre-register
  // the profile so the seam resolves it directly.
  __test_markUserReconciled(ACTOR_ID, {
    id: ACTOR_ID,
    email: `${ACTOR_ID}@example.com`,
    firstName: "HideOther",
    lastName: "Tester",
    role: "ceo",
  });
  // hide_other_leads = true is the whole point of the scenario; products
  // includes 'gbp' so the Active-Products gate keeps the parsed GBP location.
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, hide_other_leads)
    VALUES (${CLIENT_ID}, ${"Hide Other Import Firm"}, ARRAY['gbp']::text[], true)
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO client_locations (id, client_id, name)
    VALUES (${CP_LEHI}, ${CLIENT_ID}, ${"Hide Other Import Firm (Lehi)"})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        mockOpenAiThrows();

        __setParseReportPdf(async () => ({
          intake: { totalConsults: 6, commonIssues: "" },
          sales: { commonIssues: "" },
          marketing: {
            totalLeads: RAW_TOTAL_LEADS,
            gbpLocations: [
              {
                name: "Lehi",
                uniqueLeads: 60,
                reviewsGenerated: 2,
                leadQuality: { good: 33, notQuotable: 12, missedCalls: GBP_MISSED, noData: 3 },
              },
            ],
            otherLeads: {
              total: OTHER_COUNT,
              socialMedia: OTHER_COUNT,
              leadQuality: { good: 0, notQuotable: 0, missedCalls: OTHER_MISSED, noData: 0 },
            },
          },
        }));

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          // ── 1. Webhook import for the hide-enabled client ──
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

          // ── 2. Persisted marketing.totalLeads is the RAW total incl. Other ──
          const marketing = await readSectionData(isoDb, reportId, "marketing");
          assert.ok(marketing, "persisted marketing section must exist");
          assert.equal(
            marketing.totalLeads,
            RAW_TOTAL_LEADS,
            "INVARIANT: persisted totalLeads must be the raw total INCLUDING Other, even with hideOtherLeads ON — display subtracts, persist never does",
          );
          assert.equal(
            marketing.otherLeads?.count,
            OTHER_COUNT,
            "persisted otherLeads.count must be preserved so display-time subtraction has its operand",
          );

          // ── 3. Persist-time missedCallRate DOES apply hideOtherLeads (Task #2680) ──
          const intake = await readSectionData(isoDb, reportId, "intake");
          assert.ok(intake, "persisted intake section must exist");
          assert.equal(
            intake.missedCallRate,
            EXPECTED_MISSED_CALL_RATE,
            `missedCallRate must be computed over the hide-adjusted set (12/60 = 20%), got ${intake.missedCallRate}`,
          );

          // ── 4. Public report endpoint injects hideOtherLeads=true ──
          await isoDb.execute(sql`
            UPDATE reports SET status = 'final', share_token = ${SHARE_TOKEN}
            WHERE id = ${reportId}
          `);
          const shareRes = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
          const shareBody: any = await shareRes.json().catch(() => ({}));
          assert.equal(
            shareRes.status,
            200,
            `public share: expected 200, got ${shareRes.status} body=${JSON.stringify(shareBody).slice(0, 400)}`,
          );
          assert.equal(
            shareBody.client?.hideOtherLeads,
            true,
            "public report must inject client.hideOtherLeads=true for the renderer",
          );

          // The public payload's marketing section still carries the RAW
          // total + the Other count — proof the subtraction is left to the
          // renderer, not baked into stored or served data.
          const publicMarketing = (shareBody.sections || []).find(
            (s: any) => s.sectionKey === "marketing",
          )?.data;
          assert.ok(publicMarketing, "public payload must include the marketing section");
          assert.equal(
            publicMarketing.totalLeads,
            RAW_TOTAL_LEADS,
            "public payload serves the raw persisted total; the renderer subtracts",
          );
          assert.equal(
            publicMarketing.otherLeads?.count,
            OTHER_COUNT,
            "public payload serves the Other count the renderer subtracts with",
          );

          // ── 5. Renderer contract: display-time subtraction lands on the ──
          //      figure the client sees. This is the exact helper admin
          //      surfaces use; PublicReport zeroes Other equivalently.
          assert.equal(
            adjustDisplayLeads(publicMarketing.totalLeads, publicMarketing.otherLeads.count, shareBody.client.hideOtherLeads),
            RAW_TOTAL_LEADS - OTHER_COUNT,
            "display-time adjustment: 100 raw − 40 Other = 60 shown to the client",
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

    console.log("hide-other-leads-import-invariant: PASSED");
  } finally {
    restoreOpenAi();
    __resetParseReportPdf();
    __test_resetReconciledUsers();
    // The webhook route writes its import-log row through the BARE `db` import
    // (public schema, ignores the isolated-schema pin). Clean it up.
    await db
      .execute(sql`DELETE FROM webhook_import_logs WHERE client_id = ${CLIENT_ID}`)
      .catch(() => undefined);
    // Close undici keep-alive sockets so the process drains naturally.
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("hide-other-leads-import-invariant: FAILED", err);
    process.exitCode = 1;
  });
