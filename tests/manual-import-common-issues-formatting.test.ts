/* test-registration
{
  "name": "Manual PDF import paths format Common Issues (Task #2475)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/parseReportPdfSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2475 — Integration coverage: the MANUAL PDF upload routes also persist
 * the clean 🔴 Issue / ↳ Impact / ➡️ Strategic Fix Common Issues output through
 * the shared `formatCommonIssuesContent` (Task #2389) instead of the raw OCR
 * blob — matching the unattended webhook import (Task #2449 proved that path).
 *
 * Two manual surfaces both parse a PDF and hand the result back to the operator
 * review dialog, and both now format Common Issues server-side BEFORE returning:
 *
 *   1. `POST /api/reports/import-pdf` — stateless new-import parse. No client /
 *      report in scope, so the formatter runs with NEUTRAL tone.
 *   2. `POST /api/reports/:id/reimport` — re-parse into an existing report.
 *      Formatting runs on the PARSED value BEFORE `resolveCommonIssuesOnReimport`
 *      so a real parsed body is cleaned, while an empty/placeholder parsed body
 *      still degrades to "" and the existing (possibly hand-edited) value is
 *      preserved UNTOUCHED — never re-formatted or clobbered (Task #830/#1267).
 *
 * For each we prove BOTH branches of the formatter:
 *   - AI available  → the OpenAI singleton is mocked to return canonical
 *     markdown; the returned body equals the AI output (≠ raw blob).
 *   - AI fails/empty → the OpenAI singleton is mocked to throw / return empty;
 *     the returned body equals the deterministic fallback
 *     `deterministicFormatCommonIssues(raw)` (≠ raw blob).
 *
 * The OpenAI singleton is mocked exactly like the webhook integration test
 * (mutate `openai.chat.completions.create` on the shared object). DB writes run
 * inside `runInIsolatedSchema(..., { pinGetDbForCrossAsync: true })`. The
 * reimport route writes its import-log row through the BARE `db` import (public
 * schema), so that single side-table row is cleaned up in a `finally`.
 *
 * `parseReportPdf` is statically imported by the reports route, so it is
 * redirected to a configurable stub via the resolve hook registered through
 * `--import ./tests/helpers/parseReportPdfSetup.mjs` (see run-all.ts).
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db } from "../server/db";
import { registerReportRoutes } from "../server/routes/reports";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { openai } from "../server/routes/middleware";
import { deterministicFormatCommonIssues } from "../server/services/commonIssuesFormatter";
import { runInIsolatedSchema, sql } from "./db-sandbox";
import {
  __setParseReportPdf,
  __resetParseReportPdf,
} from "../server/services/pdfImportParser";

const TAG = `task-2475-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `${TAG}-actor`;
const CLIENT_ID = `${TAG}-client`;
const REIMPORT_REPORT_AI_ID = `${TAG}-ri-report-ai`;
const REIMPORT_REPORT_PRESERVE_ID = `${TAG}-ri-report-preserve`;

// Raw OCR-style blobs. Non-empty, no leading 🔴-only block and no "missing data
// source" phrasing → never a placeholder; the "Issue N: … Impact: … Strategic
// Fix: …" markers make the deterministic fallback restructure them so its
// output is provably ≠ the raw blob.
const RAW_INTAKE =
  "Issue 1: Intake team not answering inbound calls promptly. " +
  "Impact: Qualified leads roll to voicemail and never call back. " +
  "Strategic Fix: Staff a dedicated daytime receptionist.";
const RAW_SALES =
  "Issue 1: Sales reps not following up after the consult. " +
  "Impact: Warm matters stall and competitors sign them. " +
  "Strategic Fix: Enforce a 24-hour follow-up SLA in the CRM.";

// Canonical AI-formatted output the mocked OpenAI singleton returns. Distinct
// from both the raw blobs and the deterministic fallback.
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

// An already-formatted, hand-edited body that lives on an existing section and
// must be preserved verbatim when a reimport brings no new Common Issues.
const EXISTING_FORMATTED_INTAKE =
  "🔴 **Issue:** Hand-edited existing intake note that must NOT be rewritten.\n" +
  "↳ **Impact:** Operator already curated this.\n" +
  "> ➡️ **Strategic Fix:** Leave it exactly as-is on an empty reimport.";

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

function mockOpenAiSuccess(): void {
  (openai.chat.completions as any).create = async (args: any) => {
    const systemMsg = String(args?.messages?.[0]?.content ?? "");
    const content = /\bSales\b/.test(systemMsg) ? AI_SALES : AI_INTAKE;
    return { choices: [{ message: { content } }] };
  };
}

function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("simulated AI outage");
  };
}

function restoreOpenAi(): void {
  (openai.chat.completions as any).create = ORIGINAL_CREATE;
}

/** A complete parsed-report payload with configurable Common Issues bodies. */
function parsedPayload(intakeIssues: string, salesIssues: string): any {
  return {
    intake: {
      totalConsults: 10,
      missedCallRate: 0,
      avgTimeToAnswer: 0,
      qualityScore: 0,
      commonIssues: intakeIssues,
    },
    sales: {
      totalCases: 4,
      averageCaseValue: 0,
      noShowRate: 0,
      avgFollowUps: 0,
      qualityScore: 0,
      commonIssues: salesIssues,
      revenue: 0,
      dealTouchDensity: 0,
      avgAgeOpenMatters: 0,
      pipelineMomentumScore: 0,
    },
    marketing: {},
  };
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated. The
    // pre-Clerk passport-shape injection stopped working when auth migrated.
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

/** Build a multipart body carrying a minimal valid-looking PDF file field. */
function pdfFormData(): FormData {
  const fd = new FormData();
  const bytes = new TextEncoder().encode("%PDF-1.4 task-2475 synthetic pdf");
  fd.append("pdf", new Blob([bytes], { type: "application/pdf" }), "report.pdf");
  return fd;
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${ACTOR_ID}, 'ceo', ${`${ACTOR_ID}@example.com`}, 'Format', 'Tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  // The user is seeded in the isolated (uncommitted) schema, but requireAuth
  // resolves identity via its direct ambient `db` import (PUBLIC schema), which
  // never sees this row. Pre-register the profile so requireAuth admits the
  // actor without JIT-provisioning a public row.
  __test_markUserReconciled(ACTOR_ID, {
    id: ACTOR_ID,
    email: `${ACTOR_ID}@example.com`,
    firstName: "Format",
    lastName: "Tester",
    role: "ceo",
  });
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${`Manual Fmt ${TAG}`})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REIMPORT_REPORT_AI_ID}, ${CLIENT_ID}, ${"2026-01"}, 'draft', ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REIMPORT_REPORT_PRESERVE_ID}, ${CLIENT_ID}, ${"2026-02"}, 'draft', ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  // The "preserve existing" report already has a hand-edited intake section.
  await isoDb.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES (
      ${REIMPORT_REPORT_PRESERVE_ID},
      'intake',
      ${JSON.stringify({ totalConsults: 7, commonIssues: EXISTING_FORMATTED_INTAKE })}::jsonb
    )
    ON CONFLICT (report_id, section_key) DO UPDATE SET data = EXCLUDED.data
  `);
}

async function run(): Promise<void> {
  // Sanity: the deterministic fallback must restructure the raw blobs, else the
  // "≠ raw" fallback assertions would be vacuous.
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
          // Path 1a — import-pdf, AI AVAILABLE → returns AI-formatted bodies.
          // ───────────────────────────────────────────────────────────────
          mockOpenAiSuccess();
          __setParseReportPdf(async () => parsedPayload(RAW_INTAKE, RAW_SALES));

          const impAiRes = await fetch(`${baseUrl}/api/reports/import-pdf`, {
            method: "POST",
            body: pdfFormData(),
          });
          const impAi: any = await impAiRes.json().catch(() => ({}));
          assert.equal(impAiRes.status, 200, `import-pdf(AI): expected 200, got ${impAiRes.status} body=${JSON.stringify(impAi)}`);
          assert.equal(impAi.intake?.commonIssues, AI_INTAKE, "import-pdf(AI): intake must be AI-formatted");
          assert.equal(impAi.sales?.commonIssues, AI_SALES, "import-pdf(AI): sales must be AI-formatted");
          assert.notEqual(impAi.intake?.commonIssues, RAW_INTAKE, "import-pdf(AI): intake must NOT be the raw blob");
          assert.notEqual(impAi.sales?.commonIssues, RAW_SALES, "import-pdf(AI): sales must NOT be the raw blob");

          // ───────────────────────────────────────────────────────────────
          // Path 1b — import-pdf, AI FAILS → returns deterministic fallback.
          // ───────────────────────────────────────────────────────────────
          mockOpenAiThrows();
          __setParseReportPdf(async () => parsedPayload(RAW_INTAKE, RAW_SALES));

          const impFbRes = await fetch(`${baseUrl}/api/reports/import-pdf`, {
            method: "POST",
            body: pdfFormData(),
          });
          const impFb: any = await impFbRes.json().catch(() => ({}));
          assert.equal(impFbRes.status, 200, `import-pdf(fallback): expected 200, got ${impFbRes.status} body=${JSON.stringify(impFb)}`);
          assert.equal(impFb.intake?.commonIssues, detIntake, "import-pdf(fallback): intake must be deterministic fallback");
          assert.equal(impFb.sales?.commonIssues, detSales, "import-pdf(fallback): sales must be deterministic fallback");
          assert.notEqual(impFb.intake?.commonIssues, RAW_INTAKE, "import-pdf(fallback): intake must NOT be the raw blob");
          assert.notEqual(impFb.sales?.commonIssues, RAW_SALES, "import-pdf(fallback): sales must NOT be the raw blob");

          // ───────────────────────────────────────────────────────────────
          // Path 2a — reimport, AI AVAILABLE, real parsed bodies → AI-formatted.
          // (No existing sections on this report → resolveCommonIssuesOnReimport
          //  keeps the freshly-parsed, now-formatted value.)
          // ───────────────────────────────────────────────────────────────
          mockOpenAiSuccess();
          __setParseReportPdf(async () => parsedPayload(RAW_INTAKE, RAW_SALES));

          const riAiRes = await fetch(`${baseUrl}/api/reports/${REIMPORT_REPORT_AI_ID}/reimport`, {
            method: "POST",
            body: pdfFormData(),
          });
          const riAi: any = await riAiRes.json().catch(() => ({}));
          assert.equal(riAiRes.status, 200, `reimport(AI): expected 200, got ${riAiRes.status} body=${JSON.stringify(riAi)}`);
          assert.equal(riAi.parsed?.intake?.commonIssues, AI_INTAKE, "reimport(AI): intake must be AI-formatted");
          assert.equal(riAi.parsed?.sales?.commonIssues, AI_SALES, "reimport(AI): sales must be AI-formatted");
          assert.notEqual(riAi.parsed?.intake?.commonIssues, RAW_INTAKE, "reimport(AI): intake must NOT be the raw blob");

          // ───────────────────────────────────────────────────────────────
          // Path 2b — reimport with an EMPTY parsed Common Issues body must
          // PRESERVE the existing hand-edited section verbatim (formats to "" →
          // resolveCommonIssuesOnReimport keeps existing; never re-formatted).
          // ───────────────────────────────────────────────────────────────
          mockOpenAiSuccess();
          __setParseReportPdf(async () => parsedPayload("", RAW_SALES));

          const riPreserveRes = await fetch(`${baseUrl}/api/reports/${REIMPORT_REPORT_PRESERVE_ID}/reimport`, {
            method: "POST",
            body: pdfFormData(),
          });
          const riPreserve: any = await riPreserveRes.json().catch(() => ({}));
          assert.equal(riPreserveRes.status, 200, `reimport(preserve): expected 200, got ${riPreserveRes.status} body=${JSON.stringify(riPreserve)}`);
          assert.equal(
            riPreserve.parsed?.intake?.commonIssues,
            EXISTING_FORMATTED_INTAKE,
            "reimport(preserve): empty parsed must keep the existing hand-edited body untouched",
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

    console.log("manual-import-common-issues-formatting: PASSED");
  } finally {
    restoreOpenAi();
    __resetParseReportPdf();
    __test_resetReconciledUsers();
    // The reimport route writes its import-log row through the BARE `db` import
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
    console.error("manual-import-common-issues-formatting: FAILED", err);
    process.exitCode = 1;
  });
