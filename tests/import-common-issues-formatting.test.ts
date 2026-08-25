/* test-registration
{
  "name": "Import paths persist FORMATTED Common Issues (Task #2449)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/parseReportPdfSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2449 — Integration coverage: BOTH real import paths that consume the
 * shared `formatCommonIssuesContent` (Task #2389) persist the FORMATTED Common
 * Issues output into `report_sections.data.commonIssues`, never the raw OCR
 * blob.
 *
 * `formatCommonIssuesContent` has exactly two consumers (grep-confirmed), both
 * in `server/routes/reports.ts`:
 *
 *   1. The webhook auto-draft import `POST /api/webhooks/report-import` —
 *      formats the parsed Intake & Sales Common Issues and persists the
 *      `.formatted` result via `storage.upsertReportSection`.
 *   2. The interactive import helper `POST /api/ai/format-issues` — returns the
 *      formatted output, which the editor then saves via
 *      `PUT /api/reports/:id/sections/:sectionKey` (editSource `ai_format`).
 *
 * For each path we prove BOTH branches of the formatter:
 *   - AI available  → the OpenAI singleton is mocked to return canonical
 *     markdown; the persisted body equals the AI output (≠ raw blob).
 *   - AI fails/empty → the OpenAI singleton is mocked to throw / return an
 *     empty completion; the persisted body equals the deterministic fallback
 *     `deterministicFormatCommonIssues(raw)` (≠ raw blob).
 *
 * The OpenAI singleton is mocked exactly like the unit test (mutate
 * `openai.chat.completions.create` on the shared object). All DB writes run
 * inside `runInIsolatedSchema(..., { pinGetDbForCrossAsync: true })` so the
 * live `Start application` workers cannot see or race the test's rows. The
 * webhook route writes its import-log row through the BARE `db` import (not
 * `getDb()`), so that single side-table row lands in `public` and is cleaned
 * up in a `finally`.
 *
 * `parseReportPdf` is statically imported by the webhook route, so it is
 * redirected to a configurable stub via the resolve hook registered through
 * `--import ./tests/helpers/parseReportPdfSetup.mjs` (see run-all.ts).
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
import { deterministicFormatCommonIssues } from "../server/services/commonIssuesFormatter";
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

const TAG = `task-2449-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `${TAG}-actor`;
const WEBHOOK_CLIENT_ID = `${TAG}-wh-client`;
const INTERACTIVE_CLIENT_ID = `${TAG}-iv-client`;
const INTERACTIVE_REPORT_AI_ID = `${TAG}-iv-report-ai`;
const INTERACTIVE_REPORT_FALLBACK_ID = `${TAG}-iv-report-fb`;

// Raw OCR-style blobs. Non-empty, no leading 🔴-only block and no
// "missing data source" phrasing → never treated as a placeholder, and the
// "Issue N: … Impact: … Strategic Fix: …" markers make the deterministic
// fallback restructure them so its output is provably ≠ the raw blob.
const RAW_INTAKE =
  "Issue 1: Intake team not answering inbound calls promptly. " +
  "Impact: Qualified leads roll to voicemail and never call back. " +
  "Strategic Fix: Staff a dedicated daytime receptionist.";
const RAW_SALES =
  "Issue 1: Sales reps not following up after the consult. " +
  "Impact: Warm matters stall and competitors sign them. " +
  "Strategic Fix: Enforce a 24-hour follow-up SLA in the CRM.";

// Canonical AI-formatted output the mocked OpenAI singleton returns. Distinct
// from both the raw blobs and the deterministic fallback so an assertion can
// tell exactly which branch produced the persisted body.
const AI_INTAKE =
  "🔴 **Issue:** [AI] Intake team not answering inbound calls promptly.\n" +
  "↳ **Impact:** Qualified leads roll to voicemail.\n" +
  "> ➡️ **Strategic Fix:** Staff a dedicated daytime receptionist.";
const AI_SALES =
  "🔴 **Issue:** [AI] Sales reps not following up after the consult.\n" +
  // Task #4307 — impact body must clear the Task #4227 quality floor
  // (≥3 words / ≥20 chars) or the formatter refuses the AI output.
  "↳ **Impact:** Warm matters stall out quickly.\n" +
  "> ➡️ **Strategic Fix:** Enforce a 24-hour follow-up SLA.";

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

/** Mock the OpenAI singleton to return canonical markdown per section. */
function mockOpenAiSuccess(): void {
  (openai.chat.completions as any).create = async (args: any) => {
    const systemMsg = String(args?.messages?.[0]?.content ?? "");
    const content = /\bSales\b/.test(systemMsg) ? AI_SALES : AI_INTAKE;
    return { choices: [{ message: { content } }] };
  };
}

/** Mock the OpenAI singleton to throw — simulates an upstream AI failure. */
function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("simulated AI outage");
  };
}

/** Mock the OpenAI singleton to return an empty completion. */
function mockOpenAiEmpty(): void {
  (openai.chat.completions as any).create = async () => ({
    choices: [{ message: { content: "" } }],
  });
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

/** Build the webhook request body for one parsed payload. */
function webhookBody(clientId: string, reportMonth: string): Record<string, unknown> {
  const pdf = Buffer.from("%PDF-1.4 task-2449 synthetic pdf").toString("base64");
  return { clientId, reportMonth, pdf };
}

function webhookHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Send whichever auth header the env requires; in NODE_ENV=test with no
  // secret configured the route warns and proceeds (it only hard-fails in
  // production). Sending these is harmless when unset.
  if (process.env.CEO_TOOLS_API_TOKEN) {
    headers["authorization"] = `Bearer ${process.env.CEO_TOOLS_API_TOKEN}`;
  }
  if (process.env.WEBHOOK_SECRET) {
    headers["x-webhook-secret"] = process.env.WEBHOOK_SECRET;
  }
  return headers;
}

async function readSectionCommonIssues(
  isoDb: any,
  reportId: string,
  sectionKey: string,
): Promise<string | undefined> {
  const rows: any = await isoDb.execute(sql`
    SELECT data FROM report_sections
    WHERE report_id = ${reportId} AND section_key = ${sectionKey}
    LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  const data = list?.[0]?.data;
  return data?.commonIssues;
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${ACTOR_ID}, 'ceo', ${`${ACTOR_ID}@example.com`}, 'Format', 'Tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // Users are seeded in the isolated schema (uncommitted / not in public), so
  // requireAuth's ambient public-schema lookup would miss and JIT-provision.
  // Pre-register the profile so the seam resolves it directly.
  __test_markUserReconciled(ACTOR_ID, {
    id: ACTOR_ID,
    email: `${ACTOR_ID}@example.com`,
    firstName: "Format",
    lastName: "Tester",
    role: "ceo",
  });
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${WEBHOOK_CLIENT_ID}, ${`Webhook Fmt ${TAG}`})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${INTERACTIVE_CLIENT_ID}, ${`Interactive Fmt ${TAG}`})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${INTERACTIVE_REPORT_AI_ID}, ${INTERACTIVE_CLIENT_ID}, ${"2026-01"}, 'draft', ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${INTERACTIVE_REPORT_FALLBACK_ID}, ${INTERACTIVE_CLIENT_ID}, ${"2026-02"}, 'draft', ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function run(): Promise<void> {
  // Sanity: the deterministic fallback must actually restructure the raw
  // blobs, otherwise the "≠ raw" assertions below would be vacuous.
  const detIntake = deterministicFormatCommonIssues(RAW_INTAKE);
  const detSales = deterministicFormatCommonIssues(RAW_SALES);
  assert.ok(detIntake && detIntake !== RAW_INTAKE, "fixture: deterministic intake must differ from raw");
  assert.ok(detSales && detSales !== RAW_SALES, "fixture: deterministic sales must differ from raw");

  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          // ───────────────────────────────────────────────────────────────
          // Path 1a — Webhook import, AI AVAILABLE → persist AI output.
          // ───────────────────────────────────────────────────────────────
          mockOpenAiSuccess();
          __setParseReportPdf(async () => ({
            intake: { commonIssues: RAW_INTAKE },
            sales: { commonIssues: RAW_SALES },
            marketing: {},
          }));

          const whAiRes = await fetch(`${baseUrl}/api/webhooks/report-import`, {
            method: "POST",
            headers: webhookHeaders(),
            body: JSON.stringify(webhookBody(WEBHOOK_CLIENT_ID, "2026-03")),
          });
          const whAiBody: any = await whAiRes.json().catch(() => ({}));
          assert.equal(
            whAiRes.status,
            201,
            `webhook(AI): expected 201, got ${whAiRes.status} body=${JSON.stringify(whAiBody)}`,
          );
          const whAiReportId = whAiBody.reportId as string;
          assert.ok(whAiReportId, "webhook(AI): response must carry reportId");

          const whAiIntake = await readSectionCommonIssues(isoDb, whAiReportId, "intake");
          const whAiSales = await readSectionCommonIssues(isoDb, whAiReportId, "sales");
          assert.equal(whAiIntake, AI_INTAKE, "webhook(AI): intake must persist AI-formatted body");
          assert.equal(whAiSales, AI_SALES, "webhook(AI): sales must persist AI-formatted body");
          assert.notEqual(whAiIntake, RAW_INTAKE, "webhook(AI): intake must NOT be the raw blob");
          assert.notEqual(whAiSales, RAW_SALES, "webhook(AI): sales must NOT be the raw blob");

          // ───────────────────────────────────────────────────────────────
          // Path 1b — Webhook import, AI FAILS → persist deterministic fallback.
          // ───────────────────────────────────────────────────────────────
          mockOpenAiThrows();
          __setParseReportPdf(async () => ({
            intake: { commonIssues: RAW_INTAKE },
            sales: { commonIssues: RAW_SALES },
            marketing: {},
          }));

          const whFbRes = await fetch(`${baseUrl}/api/webhooks/report-import`, {
            method: "POST",
            headers: webhookHeaders(),
            body: JSON.stringify(webhookBody(WEBHOOK_CLIENT_ID, "2026-04")),
          });
          const whFbBody: any = await whFbRes.json().catch(() => ({}));
          assert.equal(
            whFbRes.status,
            201,
            `webhook(fallback): expected 201, got ${whFbRes.status} body=${JSON.stringify(whFbBody)}`,
          );
          const whFbReportId = whFbBody.reportId as string;
          assert.ok(whFbReportId, "webhook(fallback): response must carry reportId");

          const whFbIntake = await readSectionCommonIssues(isoDb, whFbReportId, "intake");
          const whFbSales = await readSectionCommonIssues(isoDb, whFbReportId, "sales");
          assert.equal(whFbIntake, detIntake, "webhook(fallback): intake must persist deterministic fallback");
          assert.equal(whFbSales, detSales, "webhook(fallback): sales must persist deterministic fallback");
          assert.notEqual(whFbIntake, RAW_INTAKE, "webhook(fallback): intake must NOT be the raw blob");
          assert.notEqual(whFbSales, RAW_SALES, "webhook(fallback): sales must NOT be the raw blob");

          // ───────────────────────────────────────────────────────────────
          // Path 2a — Interactive format-issues + save, AI AVAILABLE.
          // ───────────────────────────────────────────────────────────────
          mockOpenAiSuccess();
          const fmtAiRes = await fetch(`${baseUrl}/api/ai/format-issues`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: RAW_INTAKE, section: "intake" }),
          });
          const fmtAiBody: any = await fmtAiRes.json().catch(() => ({}));
          assert.equal(
            fmtAiRes.status,
            200,
            `format-issues(AI): expected 200, got ${fmtAiRes.status} body=${JSON.stringify(fmtAiBody)}`,
          );
          assert.equal(fmtAiBody.formatted, AI_INTAKE, "format-issues(AI): returns AI-formatted body");
          assert.equal(fmtAiBody.degraded, false, "format-issues(AI): not degraded when AI succeeds");

          const putAiRes = await fetch(
            `${baseUrl}/api/reports/${INTERACTIVE_REPORT_AI_ID}/sections/intake`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                data: { commonIssues: fmtAiBody.formatted },
                editSource: "ai_format",
              }),
            },
          );
          assert.equal(
            putAiRes.status,
            200,
            `section-put(AI): expected 200, got ${putAiRes.status}`,
          );
          const ivAiPersisted = await readSectionCommonIssues(isoDb, INTERACTIVE_REPORT_AI_ID, "intake");
          assert.equal(ivAiPersisted, AI_INTAKE, "interactive(AI): persisted body equals AI output");
          assert.notEqual(ivAiPersisted, RAW_INTAKE, "interactive(AI): persisted body is NOT the raw blob");

          // ───────────────────────────────────────────────────────────────
          // Path 2b — Interactive format-issues + save, AI EMPTY → fallback.
          // ───────────────────────────────────────────────────────────────
          mockOpenAiEmpty();
          const fmtFbRes = await fetch(`${baseUrl}/api/ai/format-issues`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: RAW_SALES, section: "sales" }),
          });
          const fmtFbBody: any = await fmtFbRes.json().catch(() => ({}));
          assert.equal(
            fmtFbRes.status,
            200,
            `format-issues(fallback): expected 200, got ${fmtFbRes.status} body=${JSON.stringify(fmtFbBody)}`,
          );
          assert.equal(fmtFbBody.formatted, detSales, "format-issues(fallback): returns deterministic fallback");
          assert.equal(fmtFbBody.degraded, true, "format-issues(fallback): degraded when AI empty");

          const putFbRes = await fetch(
            `${baseUrl}/api/reports/${INTERACTIVE_REPORT_FALLBACK_ID}/sections/sales`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                data: { commonIssues: fmtFbBody.formatted },
                editSource: "ai_format",
              }),
            },
          );
          assert.equal(
            putFbRes.status,
            200,
            `section-put(fallback): expected 200, got ${putFbRes.status}`,
          );
          const ivFbPersisted = await readSectionCommonIssues(isoDb, INTERACTIVE_REPORT_FALLBACK_ID, "sales");
          assert.equal(ivFbPersisted, detSales, "interactive(fallback): persisted body equals deterministic fallback");
          assert.notEqual(ivFbPersisted, RAW_SALES, "interactive(fallback): persisted body is NOT the raw blob");
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

    console.log("import-common-issues-formatting: PASSED");
  } finally {
    restoreOpenAi();
    __resetParseReportPdf();
    __test_resetReconciledUsers();
    // The webhook route writes its import-log row through the BARE `db`
    // import (public schema, ignores the isolated-schema pin). Clean it up.
    await db
      .execute(sql`DELETE FROM webhook_import_logs WHERE client_id = ${WEBHOOK_CLIENT_ID}`)
      .catch(() => undefined);
    // Close undici keep-alive sockets so the process drains naturally
    // (Task #2084 natural-drain mode) instead of hanging on exit.
    await getGlobalDispatcher().close().catch(() => undefined);
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error("import-common-issues-formatting: FAILED", err);
    process.exitCode = 1;
  });
