/* test-registration
{
  "name": "Hide Other leads — reimport over an edited report keeps raw persisted total (Task #2777)",
  "regression": true,
  "sweepOnlyReason": "Task #2777 — full HTTP route e2e (reimport + section PUT + public share read); real db + runInIsolatedSchema writes (DB-heavy), so not a smoke-gate candidate. Mirrors the #2760 peer entry.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/parseReportPdfSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2777 — PDF REIMPORT over a previously EDITED report vs the live
 * public report for a hideOtherLeads-enabled client.
 *
 * Task #2760 locked the invariant for the webhook IMPORT path and Task #2769
 * locked the manual EDITOR path. The remaining write path is the reimport
 * flow (`POST /api/reports/:id/reimport`), which re-parses a PDF and merges
 * it with the existing (possibly hand-edited) sections. The invariant:
 *
 *   1. The reimport response's `parsed.marketing.totalLeads` is the RAW
 *      grand total INCLUDING the Other bucket — never the display-adjusted
 *      figure. If the reimport ever returned/persisted the reduced total,
 *      the public report's display-time subtraction would run against an
 *      already-reduced value and double-subtract.
 *   2. `parsed.marketing.otherLeads.total` is preserved so the display-time
 *      subtraction keeps its operand.
 *   3. The merge really ran against the EDITED report (a non-zero operator
 *      edit survives `mergeNonZero` when the new PDF parses zero for it),
 *      and parsed-empty Common Issues never clobber existing content.
 *   4. Applying the reimport like the editor does (section PUT with
 *      `editSource: "manual_pdf_upload"`) persists the RAW total, and the
 *      share endpoint + `adjustDisplayLeads` still yield the reduced figure.
 *
 * Harness mirrors `tests/hide-other-leads-import-invariant.test.ts`:
 *   - `parseReportPdf` is redirected to a configurable stub via the resolve
 *     hook registered through `--import ./tests/helpers/parseReportPdfSetup.mjs`.
 *   - The OpenAI singleton is mocked to throw so Common Issues formatting uses
 *     its deterministic fallback (no network).
 *   - All DB writes run inside `runInIsolatedSchema(..., { pinGetDbForCrossAsync })`.
 *     The reimport route's import-log row goes through the BARE `db` import
 *     (public schema) and is cleaned up in a `finally`.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { db } from "../server/db";
// Ensure the Clerk per-request test seam is active for bare repros too.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { registerReportRoutes } from "../server/routes/reports";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { openai } from "../server/routes/middleware";
import { adjustDisplayLeads } from "../shared/missedCallRate";
import { runInIsolatedSchema, sql } from "./db-sandbox";
// Imported via the redirected specifier so the test configures the SAME stub
// singleton the reimport route resolves to through the resolve hook.
import {
  __setParseReportPdf,
  __resetParseReportPdf,
} from "../server/services/pdfImportParser";

const TAG = `task-2777-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `${TAG}-actor`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const REPORT_MONTH = "2026-06";
const SHARE_TOKEN = `${TAG}-share`;

// ── Scenario numbers ────────────────────────────────────────────────────────
// The EXISTING (previously imported + operator-edited) report: raw total 100
// = 60 GBP + 40 Other, with an operator edit (reviewsGenerated = 7).
const EXISTING_RAW_TOTAL = 100;
const EXISTING_OTHER_COUNT = 40;
const EXISTING_GBP_LEADS = 60;
const EDITED_REVIEWS = 7; // the operator's manual edit that must survive merge
const EXISTING_INTAKE_ISSUES = "🔴 Issue: existing hand-written intake issue";

// The NEW PDF being reimported: raw total 110 = 65 GBP + 45 Other. The new
// PDF parses reviewsGenerated = 0 for Lehi, so mergeNonZero must preserve the
// operator's 7 — proof the reimport really merged with the edited report.
const NEW_RAW_TOTAL = 110;
const NEW_OTHER_COUNT = 45;
const NEW_GBP_LEADS = 65;

// Task #2842 — the operator's manually-corrected webinar Lead Quality
// breakdown. The new PDF parses the webinar breakdown as ALL ZEROS, so the
// reimport merge must preserve this breakdown as a unit (and the counts via
// mergeNonZero) instead of silently reverting the correction.
const EDITED_WEBINAR_LQ = { good: 5, notQuotable: 2, missedCalls: 1, noData: 0 };
const EDITED_WEBINAR_HOT_TRANSFERS = 8;
const EXISTING_WEBINAR_REGISTRANTS = 50;
const EXISTING_WEBINAR_ATTENDEES = 20;
// A DIFFERENT non-zero breakdown for the second reimport: parsed wins, but
// the response must flag `reconciliation.webinarLeadQualityDiffers`.
const CONFLICTING_WEBINAR_LQ = { good: 9, notQuotable: 0, missedCalls: 0, noData: 0 };

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("simulated AI outage (task-2777)");
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

/** The existing marketing section in the webhook-persisted shape the reimport
 *  merge reads (`existingMarketing.gbp.locations`, `otherLeads.count`). */
function existingMarketingSection(): Record<string, unknown> {
  return {
    totalLeads: EXISTING_RAW_TOTAL,
    gbp: {
      locations: [
        {
          name: "Lehi",
          uniqueLeads: EXISTING_GBP_LEADS,
          reviewsGenerated: EDITED_REVIEWS,
          reviewsRespondedTo: 0,
          postsQaCount: 0,
          leadQuality: { good: 33, notQuotable: 12, missedCalls: 12, noData: 3 },
        },
      ],
    },
    otherLeads: {
      count: EXISTING_OTHER_COUNT,
      description: `Social Media: ${EXISTING_OTHER_COUNT}`,
      leadQuality: { good: 0, notQuotable: 0, missedCalls: 10, noData: 0 },
    },
    // Task #2842 — webinar block with an operator-corrected breakdown that
    // the reimport merge must not silently revert.
    webinar: {
      registrants: EXISTING_WEBINAR_REGISTRANTS,
      attendees: EXISTING_WEBINAR_ATTENDEES,
      hotTransfers: EDITED_WEBINAR_HOT_TRANSFERS,
      showRate: 40,
      hotTransferRate: 40,
      leadQuality: { ...EDITED_WEBINAR_LQ },
    },
  };
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${ACTOR_ID}, 'ceo', ${`${ACTOR_ID}@example.com`}, 'HideOtherReimport', 'Tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // Users are seeded in the isolated schema (not in public), so requireAuth's
  // ambient public-schema lookup would miss and JIT-provision. Pre-register
  // the profile so the seam resolves it directly.
  __test_markUserReconciled(ACTOR_ID, {
    id: ACTOR_ID,
    email: `${ACTOR_ID}@example.com`,
    firstName: "HideOtherReimport",
    lastName: "Tester",
    role: "ceo",
  });
  // hide_other_leads = true is the whole point of the scenario; products
  // includes 'gbp' so the Active-Products gate keeps the parsed GBP block
  // (otherLeads is not a product key and always survives the filter).
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, hide_other_leads)
    VALUES (${CLIENT_ID}, ${"Hide Other Reimport Firm"}, ARRAY['gbp','webinar']::text[], true)
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, ${REPORT_MONTH}, 'draft', ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES (${REPORT_ID}, 'marketing', ${JSON.stringify(existingMarketingSection())}::jsonb)
    ON CONFLICT (report_id, section_key) DO UPDATE SET data = EXCLUDED.data
  `);
  // Existing intake carries hand-written Common Issues the reimport must not
  // clobber (Task #830 preserve rule — the parsed PDF's issues are empty).
  await isoDb.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES (${REPORT_ID}, 'intake', ${JSON.stringify({ totalConsults: 6, commonIssues: EXISTING_INTAKE_ISSUES })}::jsonb)
    ON CONFLICT (report_id, section_key) DO UPDATE SET data = EXCLUDED.data
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES (${REPORT_ID}, 'sales', ${JSON.stringify({ totalCases: 2, commonIssues: "" })}::jsonb)
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

function reimportFormData(): FormData {
  const pdfBytes = Buffer.from("%PDF-1.4 task-2777 synthetic reimport pdf");
  const fd = new FormData();
  fd.append(
    "pdf",
    new Blob([pdfBytes], { type: "application/pdf" }),
    "reimport.pdf",
  );
  return fd;
}

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        mockOpenAiThrows();

        // The NEW PDF: raw grand total INCLUDES the Other bucket. Lehi's
        // reviewsGenerated parses as 0 so the merge must preserve the
        // operator's edited 7.
        __setParseReportPdf(async () => ({
          intake: { totalConsults: 8, commonIssues: "" },
          sales: { commonIssues: "" },
          marketing: {
            totalLeads: NEW_RAW_TOTAL,
            gbpLocations: [
              {
                name: "Lehi",
                uniqueLeads: NEW_GBP_LEADS,
                reviewsGenerated: 0,
                leadQuality: { good: 35, notQuotable: 14, missedCalls: 13, noData: 3 },
              },
            ],
            otherLeads: {
              total: NEW_OTHER_COUNT,
              socialMedia: NEW_OTHER_COUNT,
              leadQuality: { good: 0, notQuotable: 0, missedCalls: 11, noData: 0 },
            },
            // Task #2842 — the new PDF parses the webinar breakdown as ALL
            // ZEROS (and hotTransfers 0): the merge must preserve the
            // operator's corrected breakdown + counts, not revert them.
            webinar: {
              registrants: 0,
              attendees: 0,
              leads: 0,
              showRate: 0,
              htScheduleRate: 0,
              hotTransfers: 0,
              leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            },
          },
        }));

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          // ── 1. Reimport the new PDF ONTO the existing (edited) report ──
          const res = await fetch(`${baseUrl}/api/reports/${REPORT_ID}/reimport`, {
            method: "POST",
            body: reimportFormData(),
          });
          const body: any = await res.json().catch(() => ({}));
          assert.equal(
            res.status,
            200,
            `reimport: expected 200, got ${res.status} body=${JSON.stringify(body).slice(0, 400)}`,
          );
          assert.equal(body.reportId, REPORT_ID, "reimport response must target the existing report");
          const parsedOut = body.parsed;
          assert.ok(parsedOut?.marketing, "reimport response must carry the merged parsed marketing block");

          // ── 2. INVARIANT: merged totalLeads is RAW, INCLUDING Other ──
          // If the reimport ever returned the display-adjusted figure
          // (110 − 45 = 65) here, the editor would persist it and the public
          // report's display-time subtraction would double-subtract.
          assert.equal(
            parsedOut.marketing.totalLeads,
            NEW_RAW_TOTAL,
            "INVARIANT: reimport must return the RAW total INCLUDING Other — display subtracts, reimport never does",
          );
          assert.equal(
            parsedOut.marketing.otherLeads?.total,
            NEW_OTHER_COUNT,
            "reimport must preserve the parsed Other count so display-time subtraction has its operand",
          );

          // ── 3. The merge really ran against the EDITED report ──
          const mergedLehi = (parsedOut.marketing.gbpLocations || []).find(
            (l: any) => (l.name || "").toLowerCase().includes("lehi"),
          );
          assert.ok(mergedLehi, "merged output must still contain the Lehi location");
          assert.equal(
            mergedLehi.reviewsGenerated,
            EDITED_REVIEWS,
            "mergeNonZero must preserve the operator's edited reviewsGenerated when the new PDF parses 0 — proves the reimport merged with the EDITED report",
          );
          assert.equal(
            parsedOut.intake?.commonIssues,
            EXISTING_INTAKE_ISSUES,
            "parsed-empty Common Issues must never clobber existing hand-written content (Task #830 preserve rule)",
          );

          // ── 3b. Task #2842: webinar.leadQuality preservation on reimport ──
          // The new PDF parsed the webinar breakdown as ALL ZEROS; the merge
          // must preserve the operator's corrected breakdown AS A UNIT plus
          // the non-zero counts, instead of silently reverting the edits.
          assert.deepEqual(
            parsedOut.marketing.webinar?.leadQuality,
            EDITED_WEBINAR_LQ,
            "reimport must preserve the operator-edited webinar leadQuality breakdown when the new PDF parses all zeros",
          );
          assert.equal(
            parsedOut.marketing.webinar?.hotTransfers,
            EDITED_WEBINAR_HOT_TRANSFERS,
            "mergeNonZero must preserve the operator's webinar hotTransfers when the new PDF parses 0",
          );
          assert.equal(
            parsedOut.marketing.webinar?.registrants,
            EXISTING_WEBINAR_REGISTRANTS,
            "mergeNonZero must preserve existing webinar registrants when the new PDF parses 0",
          );
          assert.equal(
            body.reconciliation?.webinarLeadQualityDiffers,
            false,
            "no differs flag when the parsed breakdown is all zeros (nothing was overwritten)",
          );

          // ── 3c. Task #2842: a CONFLICTING non-zero parsed breakdown wins,
          // but the response must flag it so the editor can warn the operator
          // before their corrections are overwritten.
          __setParseReportPdf(async () => ({
            intake: { totalConsults: 8, commonIssues: "" },
            sales: { commonIssues: "" },
            marketing: {
              totalLeads: NEW_RAW_TOTAL,
              gbpLocations: [
                {
                  name: "Lehi",
                  uniqueLeads: NEW_GBP_LEADS,
                  reviewsGenerated: 0,
                  leadQuality: { good: 35, notQuotable: 14, missedCalls: 13, noData: 3 },
                },
              ],
              otherLeads: {
                total: NEW_OTHER_COUNT,
                socialMedia: NEW_OTHER_COUNT,
                leadQuality: { good: 0, notQuotable: 0, missedCalls: 11, noData: 0 },
              },
              webinar: {
                registrants: 55,
                attendees: 22,
                leads: 0,
                showRate: 0,
                htScheduleRate: 0,
                hotTransfers: 9,
                leadQuality: { ...CONFLICTING_WEBINAR_LQ },
              },
            },
          }));
          const conflictRes = await fetch(`${baseUrl}/api/reports/${REPORT_ID}/reimport`, {
            method: "POST",
            body: reimportFormData(),
          });
          const conflictBody: any = await conflictRes.json().catch(() => ({}));
          assert.equal(
            conflictRes.status,
            200,
            `conflicting reimport: expected 200, got ${conflictRes.status} body=${JSON.stringify(conflictBody).slice(0, 400)}`,
          );
          assert.deepEqual(
            conflictBody.parsed?.marketing?.webinar?.leadQuality,
            CONFLICTING_WEBINAR_LQ,
            "a non-zero parsed webinar breakdown wins on reimport (matching GBP semantics)",
          );
          assert.equal(
            conflictBody.reconciliation?.webinarLeadQualityDiffers,
            true,
            "INVARIANT: when a non-zero parsed webinar breakdown differs from the non-zero saved one, the reimport response must flag reconciliation.webinarLeadQualityDiffers so the operator is warned before their corrections are overwritten",
          );

          // ── 4. Apply the reimport the way the editor does: section PUT ──
          // The consent-modal apply + autosave persists the merged parsed
          // values with editSource "manual_pdf_upload"; totalLeads goes
          // through RAW.
          const appliedMarketing = {
            totalLeads: parsedOut.marketing.totalLeads,
            gbpLocations: (parsedOut.marketing.gbpLocations || []).map((loc: any) => ({
              name: loc.name,
              uniqueLeads: loc.uniqueLeads || 0,
              reviewsGenerated: loc.reviewsGenerated || 0,
              leadQuality: loc.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            })),
            otherLeads: {
              count: parsedOut.marketing.otherLeads.total,
              description: `Social Media: ${parsedOut.marketing.otherLeads.socialMedia || 0}`,
              leadQuality: parsedOut.marketing.otherLeads.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
            },
          };
          const putRes = await fetch(
            `${baseUrl}/api/reports/${REPORT_ID}/sections/marketing`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ data: appliedMarketing, editSource: "manual_pdf_upload" }),
            },
          );
          const putBody: any = await putRes.json().catch(() => ({}));
          assert.equal(
            putRes.status,
            200,
            `section PUT: expected 200, got ${putRes.status} body=${JSON.stringify(putBody).slice(0, 400)}`,
          );

          // ── 5. Persisted marketing stays RAW after the reimport apply ──
          const persisted = await readSectionData(isoDb, REPORT_ID, "marketing");
          assert.ok(persisted, "persisted marketing section must exist after the reimport apply");
          assert.equal(
            persisted.totalLeads,
            NEW_RAW_TOTAL,
            "INVARIANT: a reimport over an edited report must persist totalLeads RAW (including Other) — anything less double-subtracts at display time",
          );
          assert.equal(
            persisted.otherLeads?.count,
            NEW_OTHER_COUNT,
            "persisted otherLeads.count must carry the new PDF's Other bucket for display-time subtraction",
          );
          // Audit: proves this exercised the reimport-apply path, not ui_edit.
          const auditRows: any = await isoDb.execute(sql`
            SELECT last_edited_by, last_edit_source FROM report_sections
            WHERE report_id = ${REPORT_ID} AND section_key = 'marketing'
            LIMIT 1
          `);
          const auditList = Array.isArray(auditRows) ? auditRows : auditRows?.rows;
          assert.equal(
            auditList?.[0]?.last_edit_source,
            "manual_pdf_upload",
            "reimport apply must be audited as manual_pdf_upload",
          );
          assert.equal(auditList?.[0]?.last_edited_by, `user:${ACTOR_ID}`, "reimport apply must be attributed to the operator");

          // ── 6. Public share still flags hide + serves raw for the renderer ──
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
            NEW_RAW_TOTAL,
            "public payload serves the raw persisted total after the reimport; the renderer subtracts",
          );
          assert.equal(
            publicMarketing.otherLeads?.count,
            NEW_OTHER_COUNT,
            "public payload serves the Other count the renderer subtracts with",
          );

          // ── 7. Renderer contract: exactly ONE subtraction, at display time ──
          assert.equal(
            adjustDisplayLeads(
              publicMarketing.totalLeads,
              publicMarketing.otherLeads.count,
              shareBody.client.hideOtherLeads,
            ),
            NEW_RAW_TOTAL - NEW_OTHER_COUNT,
            "display-time adjustment: 110 raw − 45 Other = 65 shown to the client (a persist-time subtraction would have shown 20)",
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

    console.log("hide-other-leads-reimport-invariant: PASSED");
  } finally {
    restoreOpenAi();
    __resetParseReportPdf();
    __test_resetReconciledUsers();
    // The reimport route writes its import-log row through the BARE `db`
    // import (public schema, ignores the isolated-schema pin). Clean it up.
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
    console.error("hide-other-leads-reimport-invariant: FAILED", err);
    process.exitCode = 1;
  });
