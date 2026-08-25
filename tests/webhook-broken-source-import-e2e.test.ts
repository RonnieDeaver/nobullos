/* test-registration
{
  "name": "Webhook broken-source import warnings + share-time suppression e2e (Task #3769)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3769: webhook broken-source import e2e — the wired-up route must persist per-section warnings + notify the owner when Consults/Cases come in “not entered” while the prior report had them (the silent Ackah July failure), and the public share route must serve poisoned placeholder Common Issues BLANK. Isolated schema, stubbed parser, mocked OpenAI; a drift here re-silences broken-source imports end-to-end.",
  "extraNodeArgs": ["--import", "./tests/helpers/parseReportPdfSetup.mjs"],
  "tier": "small"
}
test-registration */
/**
 * Task #3769 — end-to-end coverage of the broken-source import warning on
 * the FULL `system:pdf-webhook` route (`POST /api/webhooks/report-import`)
 * plus serve-time suppression on the public share route.
 *
 * The Ackah Law 2026-07 incident: a PDF generated while its consult/case
 * component had a broken upstream data source imported `totalConsults: 0` /
 * `totalCases: 0` and a raw "Missing data source … Name_Clean (1): Ackah
 * Law" Common Issues body — the report was finalized and shared with empty
 * funnel numbers and a fake red "Issue", and nothing warned anyone.
 *
 * Drives the real HTTP route with a stubbed parser and asserts:
 *   1. The import persists a per-section `brokenSourceImportWarning` on
 *      intake (totalConsults) and sales (totalCases) when the parsed values
 *      resolve to "not entered" while the client's most recent prior report
 *      had them entered — including `rawPlaceholder: true` when the parse's
 *      field confidence says the raw body matched the placeholder.
 *   2. Stored Common Issues stay EMPTY (never a rewritten fake finding).
 *   3. The report owner gets exactly one inbox notification, asserted ONLY
 *      via its `report-import-broken-source:<reportId>` dedupe key (never
 *      total row counts — other subsystems notify on shared routes too).
 *   4. Serve-time suppression: a sales row poisoned AFTER import with the
 *      AI-rewritten placeholder class (simulating rows stored before the
 *      gate fix) is served BLANK by `GET /api/share/:token`, and the
 *      internal warning key never leaks into the public payload.
 *   5. A clean import (real values + real Common Issues) stores NO warning
 *      and sends NO broken-source notification (dedupe-prefix-scoped).
 *   6. SERVER-side finalize confirmation (review hardening): PATCHing
 *      `status: "final"` on a report whose persisted warning still names
 *      not-entered funnel metrics returns 422 `broken_source_confirm_required`
 *      until the request carries `confirmBrokenSourceFinalize: true`; stale
 *      warnings (metrics since entered) and warning-free reports finalize
 *      plainly.
 *
 * Harness mirrors `tests/webhook-gbp-import-route-e2e.test.ts`:
 *   - `parseReportPdf` redirected to a configurable stub via the resolve
 *     hook (`--import ./tests/helpers/parseReportPdfSetup.mjs`, run-all.ts).
 *   - OpenAI singleton mocked to throw (formatter fallback; no network).
 *   - `runInIsolatedSchema(..., { pinGetDbForCrossAsync: true })`; the
 *     route's import-log row goes through the BARE `db` import (public
 *     schema) and is cleaned up in a `finally`.
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
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
// Imported via the redirected specifier so the test configures the SAME stub
// singleton the webhook route resolves to through the resolve hook.
import {
  __setParseReportPdf,
  __resetParseReportPdf,
} from "../server/services/pdfImportParser";
import { BROKEN_SOURCE_NOTIFY_DEDUPE_PREFIX } from "../server/services/reportImportWarnings";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-3769-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OWNER_ID = `${TAG}-owner`;
const CLIENT_ID = `${TAG}-client`;
const PRIOR_REPORT_ID = `${TAG}-prior-report`;
const PRIOR_MONTH = "2026-06";
const REPORT_MONTH = "2026-07";

const AI_REWRITTEN_POISON = `🔴 **Issue:** Missing data source.
↳ **Impact:** The component has no data source associated with this component, so no findings are available.
➡️ **Strategic Fix:** Reconnect the data source.

Name_Clean (1): Ackah Law`;

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("simulated AI outage (task-3769)");
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
    // authenticates as that user id. Users are cloned into the isolated
    // schema (uncommitted vs public), so the seeded OWNER_ID is pre-registered
    // via __test_markUserReconciled in run() for requireAuth on the gated
    // GET /api/reports/:id read.
    (req as any).__test_clerkUserId = OWNER_ID;
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
  const pdf = Buffer.from("%PDF-1.4 task-3769 synthetic pdf").toString("base64");
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

async function readReportStatus(isoDb: any, reportId: string): Promise<string | undefined> {
  const rows: any = await isoDb.execute(sql`
    SELECT status FROM reports WHERE id = ${reportId} LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  return list?.[0]?.status;
}

/** Broken-source notifications for a report, scoped by DEDUPE KEY only. */
async function readBrokenSourceNotifications(isoDb: any, reportId: string): Promise<any[]> {
  const rows: any = await isoDb.execute(sql`
    SELECT user_id, category, title, body, dedupe_key
    FROM user_notifications
    WHERE dedupe_key = ${`${BROKEN_SOURCE_NOTIFY_DEDUPE_PREFIX}:${reportId}`}
  `);
  return (Array.isArray(rows) ? rows : rows?.rows) ?? [];
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${OWNER_ID}, 'ceo', ${`${OWNER_ID}@example.com`}, 'Broken', 'Source')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, owner_id)
    VALUES (${CLIENT_ID}, ${"Ackah Law (test)"}, ARRAY['gbp']::text[], ${OWNER_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  // Prior month (2026-06) with Consults/Cases ENTERED — the real Ackah May/
  // June trend values. This is what makes July's zeros "missing vs prior".
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, share_token)
    VALUES (${PRIOR_REPORT_ID}, ${CLIENT_ID}, ${PRIOR_MONTH}, 'final', ${`${TAG}-prior-token`})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${TAG}-prior-intake`}, ${PRIOR_REPORT_ID}, 'intake',
            ${JSON.stringify({ totalConsults: 162, noDataFlags: { totalConsults: false }, commonIssues: "" })}::jsonb)
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (id, report_id, section_key, data)
    VALUES (${`${TAG}-prior-sales`}, ${PRIOR_REPORT_ID}, 'sales',
            ${JSON.stringify({ totalCases: 16, noDataFlags: { totalCases: false }, commonIssues: "" })}::jsonb)
  `);
}

/** Parse stub shaped like the broken-source Ackah July PDF. */
function brokenSourceParseResult(): any {
  return {
    intake: { totalConsults: 0, avgTimeToAnswer: 0, qualityScore: 0, commonIssues: "" },
    sales: { totalCases: 0, averageCaseValue: 0, commonIssues: "" },
    marketing: { totalLeads: 12 },
    // The raw bodies matched the missing-data-source placeholder, so the
    // parser emitted "" values; the confidence source string is the only
    // surviving signal at the route layer (mirrors the real parser).
    fieldConfidence: {
      "intake.commonIssues": {
        confidence: "none",
        source: "empty (missing data source placeholder)",
      },
      "sales.commonIssues": {
        confidence: "none",
        source: "empty (missing data source placeholder)",
      },
    },
  };
}

/** Parse stub shaped like a HEALTHY PDF for the same client/month family. */
function healthyParseResult(): any {
  return {
    intake: { totalConsults: 150, avgTimeToAnswer: 2, qualityScore: 8, commonIssues: "" },
    sales: { totalCases: 14, averageCaseValue: 9000, commonIssues: "" },
    marketing: { totalLeads: 40 },
    fieldConfidence: {},
  };
}

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        // users is cloned into the isolated schema, so requireAuth's public-schema
        // lookup would miss OWNER_ID (and JIT-provision a stray public row). Pre-
        // register the seeded profile so the gated GET /api/reports/:id read resolves.
        __test_markUserReconciled(OWNER_ID, {
          id: OWNER_ID,
          email: `${OWNER_ID}@example.com`,
          firstName: "Broken",
          lastName: "Source",
          role: "ceo",
        });
        mockOpenAiThrows();

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          // ── Phase 1: broken-source import → warnings + notification ──
          __setParseReportPdf(async () => brokenSourceParseResult());

          const res = await fetch(`${baseUrl}/api/webhooks/report-import`, {
            method: "POST",
            headers: webhookHeaders(),
            body: JSON.stringify(webhookBody()),
          });
          const body: any = await res.json().catch(() => ({}));
          assert.equal(res.status, 201, `webhook: expected 201, got ${res.status} body=${JSON.stringify(body)}`);
          const reportId = body.reportId as string;
          assert.ok(reportId, "webhook response must carry reportId");

          const intakeData = await readSectionData(isoDb, reportId, "intake");
          const salesData = await readSectionData(isoDb, reportId, "sales");
          assert.ok(intakeData && salesData, "persisted intake + sales sections must exist");

          // Stored Common Issues stay EMPTY — the placeholder never becomes
          // a stored value, and the (mocked-dead) AI never rewrites it.
          assert.equal(intakeData.commonIssues, "", "intake commonIssues stored empty");
          assert.equal(salesData.commonIssues, "", "sales commonIssues stored empty");

          // Per-section warnings persisted with the report.
          const iw = intakeData.brokenSourceImportWarning;
          assert.ok(iw, "intake brokenSourceImportWarning persisted");
          assert.deepEqual(iw.missingMetrics, ["totalConsults"], "intake warning names totalConsults");
          assert.equal(iw.rawPlaceholder, true, "intake warning records the raw placeholder match");
          assert.equal(iw.priorReportMonth, PRIOR_MONTH, "intake warning cites the prior month");
          assert.equal(iw.source, "webhook", "intake warning source is webhook");

          const sw = salesData.brokenSourceImportWarning;
          assert.ok(sw, "sales brokenSourceImportWarning persisted");
          assert.deepEqual(sw.missingMetrics, ["totalCases"], "sales warning names totalCases");
          assert.equal(sw.rawPlaceholder, true, "sales warning records the raw placeholder match");
          assert.equal(sw.priorReportMonth, PRIOR_MONTH, "sales warning cites the prior month");

          // Owner inbox notification — asserted by dedupe key ONLY.
          const notifications = await readBrokenSourceNotifications(isoDb, reportId);
          assert.equal(
            notifications.length,
            1,
            `exactly one broken-source notification for the report, got ${notifications.length}`,
          );
          assert.equal(notifications[0].user_id, OWNER_ID, "notification targets the client owner");
          assert.equal(notifications[0].category, "system", "notification category is system");
          assert.match(
            String(notifications[0].body),
            /Consults and Cases came in empty/i,
            "notification body names the affected metrics",
          );
          assert.match(
            String(notifications[0].body),
            new RegExp(PRIOR_MONTH),
            "notification body cites the prior month",
          );

          // ── Phase 2: serve-time suppression on the public share route ──
          // Poison the sales row with the AI-rewritten class (simulating a
          // row stored BEFORE the gate fix) and finalize the report.
          await isoDb.execute(sql`
            UPDATE report_sections
            SET data = data || ${JSON.stringify({ commonIssues: AI_REWRITTEN_POISON })}::jsonb
            WHERE report_id = ${reportId} AND section_key = 'sales'
          `);
          await isoDb.execute(sql`
            UPDATE reports SET status = 'final' WHERE id = ${reportId}
          `);
          const tokenRows: any = await isoDb.execute(sql`
            SELECT share_token FROM reports WHERE id = ${reportId} LIMIT 1
          `);
          const shareToken = ((Array.isArray(tokenRows) ? tokenRows : tokenRows?.rows) ?? [])[0]
            ?.share_token as string;
          assert.ok(shareToken, "report must have a share token");

          const shareRes = await fetch(`${baseUrl}/api/share/${shareToken}`);
          const shareBody: any = await shareRes.json().catch(() => ({}));
          assert.equal(shareRes.status, 200, `share route: expected 200, got ${shareRes.status}`);
          const sections: any[] = shareBody.sections ?? [];
          const sharedSales = sections.find((s) => (s.sectionKey ?? s.section_key) === "sales");
          const sharedIntake = sections.find((s) => (s.sectionKey ?? s.section_key) === "intake");
          assert.ok(sharedSales && sharedIntake, "share payload carries intake + sales sections");
          assert.equal(
            sharedSales.data.commonIssues,
            "",
            "poisoned AI-rewritten sales Common Issues served BLANK",
          );
          assert.equal(sharedIntake.data.commonIssues, "", "intake Common Issues served blank");
          assert.ok(
            !("brokenSourceImportWarning" in (sharedSales.data ?? {})),
            "internal warning key never leaks into the shared sales payload",
          );
          assert.ok(
            !("brokenSourceImportWarning" in (sharedIntake.data ?? {})),
            "internal warning key never leaks into the shared intake payload",
          );

          // The stored row is UNCHANGED by serving (suppression is
          // serve-time only; cleanup is the prod-action's job).
          const salesAfterServe = await readSectionData(isoDb, reportId, "sales");
          assert.equal(
            salesAfterServe.commonIssues,
            AI_REWRITTEN_POISON,
            "share route must not mutate the stored row",
          );

          // ── Phase 3: healthy import → no warning, no notification ──
          __setParseReportPdf(async () => healthyParseResult());
          const res2 = await fetch(`${baseUrl}/api/webhooks/report-import`, {
            method: "POST",
            headers: webhookHeaders(),
            body: JSON.stringify({ ...webhookBody(), reportMonth: "2026-08" }),
          });
          const body2: any = await res2.json().catch(() => ({}));
          assert.equal(res2.status, 201, `healthy webhook: expected 201, got ${res2.status}`);
          const reportId2 = body2.reportId as string;
          assert.ok(reportId2, "healthy webhook response must carry reportId");

          const intake2 = await readSectionData(isoDb, reportId2, "intake");
          const sales2 = await readSectionData(isoDb, reportId2, "sales");
          assert.equal(intake2.totalConsults, 150, "healthy consults persisted");
          assert.ok(
            !("brokenSourceImportWarning" in (intake2 ?? {})),
            "healthy intake stores NO warning key",
          );
          assert.ok(
            !("brokenSourceImportWarning" in (sales2 ?? {})),
            "healthy sales stores NO warning key",
          );
          const notifications2 = await readBrokenSourceNotifications(isoDb, reportId2);
          assert.equal(notifications2.length, 0, "healthy import sends no broken-source notification");

          // ── Phase 4: server-side finalize confirmation gate ──
          // Command panel reviewed this month so the unrelated monthly-review
          // gate passes and this phase exercises ONLY the broken-source gate.
          await isoDb.execute(sql`
            INSERT INTO command_panels (client_id, last_reviewed_at)
            VALUES (${CLIENT_ID}, now())
          `);
          // Task #4227 — the finalize flow now also runs a report-quality
          // gate (degenerate Common Issues / empty Next 30 Days). Seed real
          // next-actions rows for both reports so THIS phase keeps
          // exercising ONLY the broken-source gate; the quality gate has its
          // own suite (tests/report-finalize-quality-gate.test.ts).
          const seededActions = JSON.stringify({
            ours: [{ action: "Launch review campaign this month", why: "velocity" }],
            theirs: [{ action: "Send signed-case list by the 5th", why: "accuracy" }],
          });
          for (const rid of [reportId, reportId2]) {
            await isoDb.execute(sql`
              INSERT INTO report_sections (id, report_id, section_key, data)
              VALUES (${`${TAG}-actions-${rid}`}, ${rid}, 'nextActions', ${seededActions}::jsonb)
              ON CONFLICT (report_id, section_key)
                DO UPDATE SET data = EXCLUDED.data
            `);
          }
          // Reset the broken-source report to draft (Phase 2 finalized it via
          // SQL); its persisted warnings + still-zero metrics are exactly the
          // poisoned pre-finalize state a direct API caller would hit.
          await isoDb.execute(sql`
            UPDATE reports SET status = 'draft' WHERE id = ${reportId}
          `);

          // 4a. Finalize WITHOUT the confirmation flag → 422, report stays draft.
          const fin1 = await fetch(`${baseUrl}/api/reports/${reportId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "final" }),
          });
          const fin1Body: any = await fin1.json().catch(() => ({}));
          assert.equal(
            fin1.status,
            422,
            `finalize without confirm: expected 422, got ${fin1.status} body=${JSON.stringify(fin1Body)}`,
          );
          assert.equal(
            fin1Body.error,
            "broken_source_confirm_required",
            "gate returns the broken-source error code",
          );
          assert.deepEqual(
            (fin1Body.missingMetrics ?? []).slice().sort(),
            ["totalCases", "totalConsults"],
            "gate names both still-missing funnel metrics",
          );
          assert.equal(
            await readReportStatus(isoDb, reportId),
            "draft",
            "blocked finalize leaves the report draft",
          );

          // 4b. Explicit confirmation → finalizes (and the flag itself is
          // never persisted anywhere — it is not a report column).
          const fin2 = await fetch(`${baseUrl}/api/reports/${reportId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "final", confirmBrokenSourceFinalize: true }),
          });
          const fin2Body: any = await fin2.json().catch(() => ({}));
          assert.equal(
            fin2.status,
            200,
            `confirmed finalize: expected 200, got ${fin2.status} body=${JSON.stringify(fin2Body)}`,
          );
          assert.equal(
            await readReportStatus(isoDb, reportId),
            "final",
            "confirmed finalize lands",
          );

          // 4c. Stale warning never blocks: metrics have since been entered,
          // so finalizing needs no flag even though the warning key is still
          // stored on both sections.
          await isoDb.execute(sql`
            UPDATE reports SET status = 'draft' WHERE id = ${reportId}
          `);
          // A real operator entry via the Report Form writes the value AND
          // clears the metric's No-Data flag. The stubbed parse carries no
          // fieldConfidence entries for these metrics, so the import stored
          // them as evidence-less zeros flagged No-Data (Task #3772 key-
          // presence contract); the simulation clears the flag too, or the
          // finalize gate keeps counting the metric as not entered.
          await isoDb.execute(sql`
            UPDATE report_sections
            SET data = jsonb_set(
              data || ${JSON.stringify({ totalConsults: 168 })}::jsonb,
              '{noDataFlags,totalConsults}',
              'false'::jsonb
            )
            WHERE report_id = ${reportId} AND section_key = 'intake'
          `);
          await isoDb.execute(sql`
            UPDATE report_sections
            SET data = jsonb_set(
              data || ${JSON.stringify({ totalCases: 13 })}::jsonb,
              '{noDataFlags,totalCases}',
              'false'::jsonb
            )
            WHERE report_id = ${reportId} AND section_key = 'sales'
          `);
          const fin3 = await fetch(`${baseUrl}/api/reports/${reportId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "final" }),
          });
          const fin3Body: any = await fin3.json().catch(() => ({}));
          assert.equal(
            fin3.status,
            200,
            `stale-warning finalize: expected 200, got ${fin3.status} body=${JSON.stringify(fin3Body)}`,
          );

          // 4d. Warning-free report finalizes plainly (no flag needed).
          const fin4 = await fetch(`${baseUrl}/api/reports/${reportId2}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "final" }),
          });
          assert.equal(
            fin4.status,
            200,
            `warning-free finalize: expected 200, got ${fin4.status}`,
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
          "client_data_access",
          "reports",
          "report_sections",
          "report_section_history",
          "user_notifications",
        ],
        pinGetDbForCrossAsync: true,
      },
    );

    console.log("webhook-broken-source-import-e2e: PASSED");
  } finally {
    restoreOpenAi();
    __resetParseReportPdf();
    __test_resetReconciledUsers();
    // The webhook route writes its import-log row through the BARE `db`
    // import (public schema, ignores the isolated-schema pin). Clean it up.
    await db
      .execute(sql`DELETE FROM webhook_import_logs WHERE client_id = ${CLIENT_ID}`)
      .catch(() => undefined);
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("webhook-broken-source-import-e2e: FAILED", err);
    process.exitCode = 1;
  });
