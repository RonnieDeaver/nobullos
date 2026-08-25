/* test-registration
{
  "name": "Webhook re-import over an edited/final report notifies the owner (Task #2828)",
  "regression": true,
  "sweepOnlyReason": "Task #2828 — full HTTP route e2e (4 webhook posts + real notifyUser path); real db + runInIsolatedSchema writes (DB-heavy), so not a smoke-gate candidate. Mirrors the #2817 peer entry.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/parseReportPdfSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2828 — Warn operators before an automated re-import silently
 * overwrites a report they already edited or published.
 *
 * The webhook import endpoint (`POST /api/webhooks/report-import`)
 * deliberately upserts: same client + month posts again → the report id is
 * reused and the intake/sales/marketing sections are OVERWRITTEN with the
 * new PDF's values. Manual reimports go through a per-field consent modal;
 * webhook re-posts (Zapier retries, corrected PDFs) run with no operator in
 * the loop. Task #2828 keeps the overwrite (webhook ingest stays trusted
 * automation — notify, don't block) but pushes a per-user inbox notification
 * to the client owner when the report being overwritten was "protected":
 * it has report_section_history rows with a HUMAN editor, or status=final.
 *
 * Under guard here:
 *   1. A fresh webhook CREATE fires NO overwrite notification.
 *   2. A webhook UPSERT into a pristine automation-only report (all history
 *      rows are `system:*` editors) fires NO overwrite notification.
 *   3. After a human edit lands in report_section_history (`user:<id>` /
 *      section_put), a webhook re-post DOES fire the notification: one
 *      `user_notifications` row for the client owner, category `system`,
 *      dedupeKey `report-import-overwrite:<reportId>`, deepLink to the
 *      report, metadata.reasons including "hand-edited".
 *   4. With the first notification read (dedupe key freed) and the report
 *      ALSO marked final, another re-post fires a fresh notification whose
 *      reasons include BOTH "finalized" and "hand-edited".
 *
 * Harness mirrors `tests/hide-other-leads-webhook-upsert-no-gbp.test.ts`:
 *   - `parseReportPdf` is redirected to a configurable stub via the resolve
 *     hook registered through `--import ./tests/helpers/parseReportPdfSetup.mjs`.
 *   - The OpenAI singleton is mocked to throw so Common Issues formatting
 *     uses its deterministic fallback (no network).
 *   - All DB writes run inside `runInIsolatedSchema(..., { pinGetDbForCrossAsync })`.
 *     `user_notifications` and `users` are cloned so the REAL notifyUser()
 *     path (combined CTE + dedupe) is exercised end-to-end against the
 *     isolated schema. The route's import-log rows go through the BARE `db`
 *     import (public schema) and are cleaned up in a `finally`.
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

const TAG = `task-2828-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = `${TAG}-client`;
const OWNER_ID = `${TAG}-owner`;
const EDITOR_ID = `${TAG}-editor`;
const REPORT_MONTH = "2026-05";
const DEDUPE_PREFIX = "report-import-overwrite:";

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("simulated AI outage (task-2828)");
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
    (req as any).__test_clerkUserId = `${TAG}-actor`;
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
  const pdf = Buffer.from("%PDF-1.4 task-2828 synthetic pdf").toString("base64");
  return { clientId: CLIENT_ID, reportMonth: REPORT_MONTH, pdf };
}

/** Minimal parsed payload; the round number varies a value so each post
 *  genuinely rewrites section data. */
function parsedPayload(round: number): any {
  return {
    intake: { totalConsults: 4 + round, commonIssues: "" },
    sales: { commonIssues: "" },
    marketing: {
      totalLeads: 50 + round,
      googleAds: {
        uniqueLeads: 50 + round,
        adSpend: 2000,
        leadQuality: { good: 30, notQuotable: 5, missedCalls: 5, noData: 0 },
      },
    },
  };
}

async function seed(isoDb: any): Promise<void> {
  // The owner must be a REAL users row: notifyUser()'s combined CTE
  // (and its userExists fallback) skips recipients that don't exist.
  await isoDb.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${OWNER_ID}, ${`${TAG}-owner@example.test`}, ${"Task2828"}, ${"Owner"})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, owner_id)
    VALUES (${CLIENT_ID}, ${"Overwrite Warn Firm"}, ARRAY['google_ads']::text[], ${OWNER_ID})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function postWebhook(baseUrl: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/webhooks/report-import`, {
    method: "POST",
    headers: webhookHeaders(),
    body: JSON.stringify(webhookBody()),
  });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function fetchOverwriteNotifications(isoDb: any, reportId: string): Promise<any[]> {
  const rows: any = await isoDb.execute(sql`
    SELECT id, user_id, category, title, body, deep_link, dedupe_key, metadata, read_at
    FROM user_notifications
    WHERE user_id = ${OWNER_ID}
      AND dedupe_key = ${`${DEDUPE_PREFIX}${reportId}`}
    ORDER BY created_at ASC
  `);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        mockOpenAiThrows();

        let round = 1;
        __setParseReportPdf(async () => parsedPayload(round));

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          // ── Round 1: fresh CREATE — no overwrite, no notification ──
          const r1 = await postWebhook(baseUrl);
          assert.equal(
            r1.status,
            201,
            `round 1: expected 201, got ${r1.status} body=${JSON.stringify(r1.body)}`,
          );
          const reportId = r1.body.reportId as string;
          assert.ok(reportId, "round 1: webhook response must carry reportId");

          let notes = await fetchOverwriteNotifications(isoDb, reportId);
          assert.equal(
            notes.length,
            0,
            "round 1 (fresh create): NO overwrite notification may fire — there was nothing to overwrite",
          );

          // ── Round 2: UPSERT over an automation-only report — silent ──
          // The only history rows so far were written by the webhook itself
          // (`system:pdf-webhook`); the report is still draft. Trusted
          // automation replacing trusted automation stays quiet.
          round = 2;
          const r2 = await postWebhook(baseUrl);
          assert.equal(
            r2.status,
            201,
            `round 2: expected 201, got ${r2.status} body=${JSON.stringify(r2.body)}`,
          );
          assert.equal(
            r2.body.reportId,
            reportId,
            "round 2: upsert must reuse the existing report id",
          );
          notes = await fetchOverwriteNotifications(isoDb, reportId);
          assert.equal(
            notes.length,
            0,
            "round 2 (automation-only history, draft status): NO overwrite notification may fire — system:* editors are not operator edits",
          );

          // ── Human edit lands: a real operator touches the intake section ──
          await isoDb.execute(sql`
            INSERT INTO report_section_history
              (report_id, section_key, previous_data, new_data, data_changed, edited_by, edit_source)
            VALUES
              (${reportId}, ${"intake"}, ${JSON.stringify({})}::jsonb,
               ${JSON.stringify({ totalConsults: 99 })}::jsonb, true,
               ${`user:${EDITOR_ID}`}, ${"section_put"})
          `);

          // ── Round 3: re-post overwrites the hand-edited report → notify ──
          round = 3;
          const r3 = await postWebhook(baseUrl);
          assert.equal(
            r3.status,
            201,
            `round 3: expected 201, got ${r3.status} body=${JSON.stringify(r3.body)}`,
          );
          notes = await fetchOverwriteNotifications(isoDb, reportId);
          assert.equal(
            notes.length,
            1,
            `round 3 (hand-edited report overwritten): exactly ONE inbox notification for the owner, got ${notes.length}`,
          );
          const n1 = notes[0];
          assert.equal(n1.user_id, OWNER_ID, "notification must target the client owner");
          assert.equal(n1.category, "system", "notification category must be 'system'");
          assert.equal(
            n1.deep_link,
            `/reports/${reportId}`,
            "notification must deep-link to the overwritten report",
          );
          assert.ok(
            String(n1.title).toLowerCase().includes("overwrote"),
            `title must say the import overwrote the report, got: ${n1.title}`,
          );
          assert.ok(
            String(n1.body).includes(REPORT_MONTH) &&
              String(n1.body).includes("Overwrite Warn Firm"),
            `body must name the month and the firm, got: ${n1.body}`,
          );
          const meta1 = typeof n1.metadata === "string" ? JSON.parse(n1.metadata) : n1.metadata;
          assert.deepEqual(
            meta1?.reasons,
            ["hand-edited"],
            `round 3 reasons must be exactly ["hand-edited"] (report is still draft), got ${JSON.stringify(meta1?.reasons)}`,
          );
          assert.equal(meta1?.reportId, reportId, "metadata must carry the report id");
          assert.equal(meta1?.reportMonth, REPORT_MONTH, "metadata must carry the month");

          // ── Round 4: read the alert (frees the dedupe key), finalize the
          //    report, re-post → fresh notification citing BOTH reasons ──
          await isoDb.execute(sql`
            UPDATE user_notifications SET read_at = NOW()
            WHERE user_id = ${OWNER_ID} AND dedupe_key = ${`${DEDUPE_PREFIX}${reportId}`}
          `);
          await isoDb.execute(sql`
            UPDATE reports SET status = 'final' WHERE id = ${reportId}
          `);
          round = 4;
          const r4 = await postWebhook(baseUrl);
          assert.equal(
            r4.status,
            201,
            `round 4: expected 201, got ${r4.status} body=${JSON.stringify(r4.body)}`,
          );
          notes = await fetchOverwriteNotifications(isoDb, reportId);
          assert.equal(
            notes.length,
            2,
            `round 4 (finalized + hand-edited, dedupe key freed): a SECOND notification must land, got ${notes.length} total`,
          );
          const n2 = notes[1];
          const meta2 = typeof n2.metadata === "string" ? JSON.parse(n2.metadata) : n2.metadata;
          assert.deepEqual(
            (meta2?.reasons ?? []).slice().sort(),
            ["finalized", "hand-edited"],
            `round 4 reasons must include BOTH finalized and hand-edited, got ${JSON.stringify(meta2?.reasons)}`,
          );
          assert.equal(n2.read_at, null, "round 4 notification must be a fresh UNREAD row");
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
          "user_notifications",
        ],
        pinGetDbForCrossAsync: true,
      },
    );

    console.log("webhook-overwrite-edited-report-notification: PASSED");
  } finally {
    restoreOpenAi();
    __resetParseReportPdf();
    // The webhook route writes its import-log rows through the BARE `db`
    // import (public schema, ignores the isolated-schema pin). Clean them up.
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
    console.error("webhook-overwrite-edited-report-notification: FAILED", err);
    process.exitCode = 1;
  });
