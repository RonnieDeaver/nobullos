/* test-registration
{
  "name": "Report section history editorUser resolution (Task #1277)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1277 — Regression coverage for the report-section history endpoint's
 * `editorUser` resolution (added by Task #833).
 *
 * The history endpoint `GET /api/reports/:id/sections/:sectionKey/history`
 * parses each row's `edited_by` editor token. Rows shaped `user:<id>` get
 * looked up via `resolveLastEditedUsers` and the resolved user record is
 * attached as `editorUser` on the response. Rows shaped `system:*` and the
 * literal `unknown` token must carry `editorUser: null` (we never resolve
 * a fake user for them). The companion `SectionAuditInfo` component then
 * uses `editorUser` to render "First Last (email)" — without that field
 * the panel would silently regress back to raw editor tokens.
 *
 * This test pins:
 *   1. CEO admin: `user:<id>` rows return `editorUser` populated with
 *      `{ id, firstName, lastName, email }` from the seeded user.
 *   2. CEO admin: `system:pdf-webhook` rows return `editorUser: null`
 *      and preserve the raw `editedBy` token.
 *   3. CEO admin: the literal `unknown` token returns `editorUser: null`.
 *   4. CEO admin: a `user:<id>` row pointing at a user that no longer
 *      exists returns `editorUser: null` (the route never invents a
 *      placeholder; the component is responsible for the fallback).
 *   5. Non-admin (account_manager) gets HTTP 403.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerReportRoutes } from "../server/routes/reports";
import {
  upsertReportSection,
  getReportSectionHistory,
} from "../server/storage/reportStorage";

const TAG = `task-1277-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CEO_ID = `${TAG}-ceo`;
const AM_ID = `${TAG}-am`;
const EDITOR_ID = `${TAG}-editor`;
const GHOST_ID = `${TAG}-ghost`; // referenced by edited_by but never seeded
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const WEBHOOK_LOG_ID = `${TAG}-wlog`;
const SECTION_KEY = "sales";

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM report_section_history WHERE report_id = ${REPORT_ID}`);
  await db.execute(sql`DELETE FROM report_sections WHERE report_id = ${REPORT_ID}`);
  await db.execute(sql`DELETE FROM reports WHERE id = ${REPORT_ID}`);
  await db.execute(sql`DELETE FROM webhook_import_logs WHERE id = ${WEBHOOK_LOG_ID}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${CEO_ID}, ${AM_ID}, ${EDITOR_ID})`);
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${CEO_ID}, 'ceo', ${`${CEO_ID}@example.com`}, 'Audit', 'CEO')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${AM_ID}, 'account_manager', ${`${AM_ID}@example.com`}, 'Account', 'Manager')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (
      ${EDITOR_ID}, 'admin',
      ${"editor.user@example.com"},
      ${"Edie"}, ${"Torr"}
    )
    ON CONFLICT (id) DO UPDATE SET
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      email = EXCLUDED.email
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${`Editor User Test ${TAG}`})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, ${"2026-03"}, ${"draft"}, ${CEO_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO webhook_import_logs (id, client_id, report_month, status)
    VALUES (${WEBHOOK_LOG_ID}, ${CLIENT_ID}, ${"2026-03"}, ${"success"})
    ON CONFLICT (id) DO NOTHING
  `);

  // Build four history rows by exercising the real storage helper so the
  // shape stays identical to production writes.
  await upsertReportSection(
    { reportId: REPORT_ID, sectionKey: SECTION_KEY, data: { totalCases: 1 } },
    { editor: `user:${EDITOR_ID}`, source: "ui_edit" },
  );
  await upsertReportSection(
    { reportId: REPORT_ID, sectionKey: SECTION_KEY, data: { totalCases: 2 } },
    {
      editor: "system:pdf-webhook",
      source: "pdf_webhook",
      webhookImportLogId: WEBHOOK_LOG_ID,
    },
  );
  await upsertReportSection(
    { reportId: REPORT_ID, sectionKey: SECTION_KEY, data: { totalCases: 3 } },
    { editor: `user:${GHOST_ID}`, source: "ui_edit" },
  );
  // The "unknown" sentinel is what the backfill writes when it cannot
  // attribute a pre-existing row. The storage helper rejects unknown
  // sources, so we splice this row in via raw SQL — matching what the
  // backfill script does in production.
  const seeded = await getReportSectionHistory(REPORT_ID, SECTION_KEY);
  const liveSectionId = seeded[0].reportSectionId;
  await db.execute(sql`
    INSERT INTO report_section_history (
      report_section_id, report_id, section_key, previous_data, new_data,
      data_changed, edited_by, edit_source, created_at
    ) VALUES (
      ${liveSectionId}, ${REPORT_ID}, ${SECTION_KEY}, NULL,
      ${JSON.stringify({ totalCases: 3 })}::jsonb, false,
      ${"unknown"}, ${"unknown"}, now()
    )
  `);
}

function buildApp(actorId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id (committed public-schema users row).
    (req as any).__test_clerkUserId = actorId;
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

async function fetchHistory(baseUrl: string): Promise<{ status: number; body: any }> {
  const r = await fetch(
    `${baseUrl}/api/reports/${REPORT_ID}/sections/${SECTION_KEY}/history`,
  );
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function run(): Promise<void> {
  await cleanup();
  await seed();

  // ── Section 1: CEO admin gets editorUser resolved for the four token shapes
  const ceoApp = buildApp(CEO_ID);
  const ceo = await listen(ceoApp);
  try {
    const res = await fetchHistory(ceo.baseUrl);
    assert.equal(res.status, 200, `CEO: expected 200, got ${res.status}`);
    assert.ok(Array.isArray(res.body), "CEO: history response should be an array");

    const rows: any[] = res.body;
    assert.ok(rows.length >= 4, `CEO: expected >=4 history rows, got ${rows.length}`);

    // Each returned row must explicitly carry `editorUser` (null or object),
    // otherwise the SectionAuditInfo panel falls back to raw token rendering.
    for (const row of rows) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(row, "editorUser"),
        `CEO: every history row must include 'editorUser' key (row=${JSON.stringify(row)})`,
      );
    }

    const userRow = rows.find((r) => r.editedBy === `user:${EDITOR_ID}`);
    assert.ok(userRow, "CEO: row for user:<seeded editor> must be present");
    assert.ok(
      userRow.editorUser && typeof userRow.editorUser === "object",
      `CEO: user:<id> row must have populated editorUser, got ${JSON.stringify(userRow.editorUser)}`,
    );
    assert.equal(userRow.editorUser.id, EDITOR_ID, "CEO: editorUser.id matches editor");
    assert.equal(userRow.editorUser.firstName, "Edie", "CEO: editorUser.firstName matches");
    assert.equal(userRow.editorUser.lastName, "Torr", "CEO: editorUser.lastName matches");
    assert.equal(
      userRow.editorUser.email,
      "editor.user@example.com",
      "CEO: editorUser.email matches",
    );

    const systemRow = rows.find((r) => r.editedBy === "system:pdf-webhook");
    assert.ok(systemRow, "CEO: row for system:pdf-webhook must be present");
    assert.equal(
      systemRow.editorUser,
      null,
      `CEO: system:* rows must have editorUser=null, got ${JSON.stringify(systemRow.editorUser)}`,
    );
    assert.equal(
      systemRow.editSource,
      "pdf_webhook",
      "CEO: system:pdf-webhook row keeps pdf_webhook source",
    );

    const unknownRow = rows.find((r) => r.editedBy === "unknown");
    assert.ok(unknownRow, "CEO: row for literal 'unknown' editor must be present");
    assert.equal(
      unknownRow.editorUser,
      null,
      `CEO: 'unknown' editor rows must have editorUser=null, got ${JSON.stringify(unknownRow.editorUser)}`,
    );

    const ghostRow = rows.find((r) => r.editedBy === `user:${GHOST_ID}`);
    assert.ok(ghostRow, "CEO: row for user:<deleted-id> must be present");
    assert.equal(
      ghostRow.editorUser,
      null,
      `CEO: user:<id> rows whose user does not exist must have editorUser=null, got ${JSON.stringify(ghostRow.editorUser)}`,
    );
  } finally {
    await closeServer(ceo.server);
  }

  // ── Section 2: account_manager is rejected with HTTP 403
  const amApp = buildApp(AM_ID);
  const am = await listen(amApp);
  try {
    const res = await fetchHistory(am.baseUrl);
    assert.equal(
      res.status,
      403,
      `account_manager: expected 403, got ${res.status} body=${JSON.stringify(res.body)}`,
    );
  } finally {
    await closeServer(am.server);
  }

  console.log("report-section-history-editor-user: PASSED");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(async () => {
    await cleanup().catch(() => undefined);
  })
  .catch(async (err) => {
    console.error("report-section-history-editor-user: FAILED", err);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  });
