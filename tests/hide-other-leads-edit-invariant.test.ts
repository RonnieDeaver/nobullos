/* test-registration
{
  "name": "Hide Other leads — editor edit/save keeps raw persisted total (Task #2769)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2769: the manual editor path (section PUT) also writes marketing.totalLeads. Gate the edit/save round-trip invariant (persist RAW incl. Other; subtract only at display) so an edit path that ever saves the display-adjusted number — which would make the public report double-subtract — fails fast. Self-contained isolated-schema DB test.",
  "tier": "small"
}
test-registration */
/**
 * Task #2769 — Manual report editor edit/save vs the live public report for a
 * hideOtherLeads-enabled client.
 *
 * Task #2760 locked the invariant for the PDF webhook IMPORT path: persist
 * `marketing.totalLeads` RAW (including the Other bucket) and subtract Other
 * only at display time. The manual editor path
 * (`PUT /api/reports/:id/sections/:sectionKey`) also writes
 * `marketing.totalLeads`, so this test proves the operator round-trip keeps
 * the raw-persist convention:
 *
 *   1. The editor read (`GET /api/reports/:id`) serves the RAW totalLeads —
 *      the operator sees the full picture, not the display-adjusted figure.
 *   2. An operator edit + save (PUT with `editSource: "ui_edit"`) persists the
 *      RAW totalLeads unchanged. If any edit path ever saved the
 *      display-adjusted number, the public report would double-subtract.
 *   3. The public share endpoint still injects `client.hideOtherLeads = true`,
 *      serves the RAW total + Other count, and `adjustDisplayLeads` yields the
 *      reduced figure — subtraction stays display-time only.
 *
 * Harness mirrors `tests/hide-other-leads-import-invariant.test.ts`, but the
 * report + sections are seeded directly (no PDF parse stub / no OpenAI needed —
 * a `ui_edit` save never calls AI formatting).
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { registerReportRoutes } from "../server/routes/reports";
import { adjustDisplayLeads } from "../shared/missedCallRate";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { runInIsolatedSchema, sql } from "./db-sandbox";

// Ensure the Clerk per-request test seam is active for bare repros too.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-2769-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `${TAG}-actor`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const REPORT_MONTH = "2026-06";
const SHARE_TOKEN = `${TAG}-share`;

// ── Scenario numbers ────────────────────────────────────────────────────────
// Raw total INCLUDES the Other bucket (60 GBP + 40 Other).
const RAW_TOTAL_LEADS = 100;
const OTHER_COUNT = 40;
const GBP_LEADS = 60;
// The operator edit: bump reviewsGenerated. The point is that saving an
// UNRELATED edit must not disturb the raw totalLeads.
const EDITED_REVIEWS = 7;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. ACTOR_ID is seeded only in the isolated
    // schema, so it is also pre-registered in the requireAuth test registry
    // (after seed) — requireAuth uses the profile directly instead of a
    // public-schema SELECT/JIT-insert, and populates req.user.claims.sub.
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

function seededMarketing(): Record<string, unknown> {
  return {
    totalLeads: RAW_TOTAL_LEADS,
    gbpLocations: [
      {
        name: "Lehi",
        uniqueLeads: GBP_LEADS,
        reviewsGenerated: 2,
        leadQuality: { good: 33, notQuotable: 12, missedCalls: 12, noData: 3 },
      },
    ],
    otherLeads: {
      count: OTHER_COUNT,
      socialMedia: OTHER_COUNT,
      leadQuality: { good: 0, notQuotable: 0, missedCalls: 10, noData: 0 },
    },
  };
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${ACTOR_ID}, 'ceo', ${`${ACTOR_ID}@example.com`}, 'HideOtherEdit', 'Tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // Users are seeded in the isolated schema (not in public), so requireAuth's
  // ambient public-schema lookup would miss and JIT-provision. Pre-register
  // the profile so the seam resolves it directly.
  __test_markUserReconciled(ACTOR_ID, {
    id: ACTOR_ID,
    email: `${ACTOR_ID}@example.com`,
    firstName: "HideOtherEdit",
    lastName: "Tester",
    role: "ceo",
  });
  // hide_other_leads = true is the whole point of the scenario; products
  // includes 'gbp' so the Active-Products gate at the section-PUT boundary
  // keeps the GBP block (otherLeads is not a product key and always survives).
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, hide_other_leads)
    VALUES (${CLIENT_ID}, ${"Hide Other Edit Firm"}, ARRAY['gbp']::text[], true)
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, ${REPORT_MONTH}, 'draft', ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES (${REPORT_ID}, 'marketing', ${JSON.stringify(seededMarketing())}::jsonb)
    ON CONFLICT (report_id, section_key) DO UPDATE SET data = EXCLUDED.data
  `);
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

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          // ── 1. Editor read serves the RAW total (what the operator loads) ──
          const editorRes = await fetch(`${baseUrl}/api/reports/${REPORT_ID}`);
          const editorBody: any = await editorRes.json().catch(() => ({}));
          assert.equal(
            editorRes.status,
            200,
            `editor GET: expected 200, got ${editorRes.status} body=${JSON.stringify(editorBody).slice(0, 400)}`,
          );
          const editorMarketing = (editorBody.sections || []).find(
            (s: any) => s.sectionKey === "marketing",
          )?.data;
          assert.ok(editorMarketing, "editor payload must include the marketing section");
          assert.equal(
            editorMarketing.totalLeads,
            RAW_TOTAL_LEADS,
            "editor read must serve the RAW total including Other — the operator edits the full picture",
          );

          // ── 2. Operator edit + save: unrelated tweak, raw total round-trips ──
          // Simulate exactly what the editor does: take the served section
          // data, mutate one field, PUT it back as a ui_edit.
          const edited = JSON.parse(JSON.stringify(editorMarketing));
          edited.gbpLocations[0].reviewsGenerated = EDITED_REVIEWS;
          const putRes = await fetch(
            `${baseUrl}/api/reports/${REPORT_ID}/sections/marketing`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ data: edited, editSource: "ui_edit" }),
            },
          );
          const putBody: any = await putRes.json().catch(() => ({}));
          assert.equal(
            putRes.status,
            200,
            `section PUT: expected 200, got ${putRes.status} body=${JSON.stringify(putBody).slice(0, 400)}`,
          );

          // ── 3. Persisted marketing.totalLeads stays RAW after the edit ──
          const persisted = await readSectionData(isoDb, REPORT_ID, "marketing");
          assert.ok(persisted, "persisted marketing section must exist after the edit");
          assert.equal(
            persisted.totalLeads,
            RAW_TOTAL_LEADS,
            "INVARIANT: an operator edit + save must persist totalLeads RAW (including Other) — if an edit path ever saved the display-adjusted number, the public report would double-subtract",
          );
          assert.equal(
            persisted.otherLeads?.count,
            OTHER_COUNT,
            "persisted otherLeads.count must survive the edit so display-time subtraction has its operand",
          );
          assert.equal(
            persisted.gbpLocations?.[0]?.reviewsGenerated,
            EDITED_REVIEWS,
            "the operator's actual edit must land (proves the PUT really wrote)",
          );
          // The edit-audit trail must attribute the write to the operator's
          // ui_edit — proves this exercised the manual editor path, not import.
          const auditRows: any = await isoDb.execute(sql`
            SELECT last_edited_by, last_edit_source FROM report_sections
            WHERE report_id = ${REPORT_ID} AND section_key = 'marketing'
            LIMIT 1
          `);
          const auditList = Array.isArray(auditRows) ? auditRows : auditRows?.rows;
          assert.equal(auditList?.[0]?.last_edit_source, "ui_edit", "edit must be audited as ui_edit");
          assert.equal(auditList?.[0]?.last_edited_by, `user:${ACTOR_ID}`, "edit must be attributed to the operator");

          // ── 4. Public share still flags hide + serves raw for the renderer ──
          await isoDb.execute(sql`
            UPDATE reports SET status = 'final', share_token = ${SHARE_TOKEN}
            WHERE id = ${REPORT_ID}
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
          const publicMarketing = (shareBody.sections || []).find(
            (s: any) => s.sectionKey === "marketing",
          )?.data;
          assert.ok(publicMarketing, "public payload must include the marketing section");
          assert.equal(
            publicMarketing.totalLeads,
            RAW_TOTAL_LEADS,
            "public payload serves the raw persisted total after the edit; the renderer subtracts",
          );
          assert.equal(
            publicMarketing.otherLeads?.count,
            OTHER_COUNT,
            "public payload serves the Other count the renderer subtracts with",
          );

          // ── 5. Renderer contract: display-time subtraction is intact ──
          assert.equal(
            adjustDisplayLeads(
              publicMarketing.totalLeads,
              publicMarketing.otherLeads.count,
              shareBody.client.hideOtherLeads,
            ),
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

    console.log("hide-other-leads-edit-invariant: PASSED");
  } finally {
    __test_resetReconciledUsers();
    // Close undici keep-alive sockets so the process drains naturally.
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("hide-other-leads-edit-invariant: FAILED", err);
    process.exitCode = 1;
  });
