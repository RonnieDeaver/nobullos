/* test-registration
{
  "name": "Hide Other leads — webhook upsert + no-gbp Active-Products gate keep raw totals + pushed missed-call rate preservation (Tasks #2817/#4983)",
  "regression": true,
  "sweepOnlyReason": "Tasks #2817/#4983 — full HTTP route e2e (webhook create + upsert overwrite + re-import preservation of a pushed missed-call rate); real db + runInIsolatedSchema writes (DB-heavy), so not a smoke-gate candidate. Mirrors the #2760/#2777 peer entries.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/parseReportPdfSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2817 — Webhook-created reports must not silently drop hidden Other
 * leads either, on the webhook branches Task #2760 did NOT cover.
 *
 * #2760 locked the invariant for the webhook CREATE path for a hide-Other
 * client that OWNS the gbp product. Two webhook branches remained unguarded,
 * and both run with no operator in the loop:
 *
 *   A. hideOtherLeads client WITHOUT the gbp product. The Active-Products
 *      gate (`applyActiveProductsFilter`) structurally DELETES the parsed
 *      GBP blocks before any aggregate is computed or persisted. That
 *      deletion is the closest live analog to a "pre-suppression" bug: if
 *      the gate (or a future edit to it) ever took `otherLeads` or the raw
 *      grand total down with the inactive-product blocks, the raw total
 *      would be destroyed at creation time and nothing would catch it.
 *      (`PRODUCT_TO_MARKETING_KEYS` maps "other" to NO marketing keys, by
 *      design — this test is the webhook-path guard on that contract.)
 *
 *   B. Webhook UPSERT into an EXISTING report (same client + month posts
 *      again). This branch reuses the report id and OVERWRITES the persisted
 *      sections via `storage.upsertReportSection` — no consent modal, no
 *      merge. The overwritten marketing section must still carry the new
 *      payload's RAW totalLeads + otherLeads.count.
 *
 * Invariant under guard (documented at the webhook persist block in
 * `server/routes/reports.ts`, Task #2760):
 *   - `marketing.totalLeads` is persisted RAW — INCLUDING the Other bucket —
 *     even when the client's `hideOtherLeads` flag is ON. Display subtracts;
 *     persist never does (or display would double-subtract).
 *   - `marketing.otherLeads.count` is preserved so display-time subtraction
 *     keeps its operand.
 *   - The ONLY persist-time application of hideOtherLeads is the
 *     missedCallRate (Task #2680): numerator and denominator adjusted
 *     symmetrically.
 *
 * Rounds 3–4 (Task #4983) extend the upsert lane to the missed-call
 * write-path preservation rule: a re-import whose buckets carry ZERO missed
 * calls (structural defaults) must not stamp a recomputed 0 over a stored
 * pushed rate (round 3 preserves it), while a parsed pushed headline rate
 * wins over the prior (round 4).
 *
 * Harness mirrors `tests/hide-other-leads-import-invariant.test.ts`:
 *   - `parseReportPdf` is redirected to a configurable stub via the resolve
 *     hook registered through `--import ./tests/helpers/parseReportPdfSetup.mjs`.
 *   - The OpenAI singleton is mocked to throw so Common Issues formatting uses
 *     its deterministic fallback (no network).
 *   - All DB writes run inside `runInIsolatedSchema(..., { pinGetDbForCrossAsync })`.
 *     The route's import-log rows go through the BARE `db` import (public
 *     schema) and are cleaned up in a `finally`.
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
import { runInIsolatedSchema, sql } from "./db-sandbox";
// Imported via the redirected specifier so the test configures the SAME stub
// singleton the webhook route resolves to through the resolve hook.
import {
  __setParseReportPdf,
  __resetParseReportPdf,
} from "../server/services/pdfImportParser";

const TAG = `task-2817-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_MONTH = "2026-06";

// ── Scenario numbers ────────────────────────────────────────────────────────
// Round 1 (CREATE, no-gbp client): raw total INCLUDES the Other bucket.
// The payload ALSO carries a GBP location so the Active-Products gate has
// real inactive-product data to delete — proving the deletion never takes
// the raw total or Other with it.
const R1_RAW_TOTAL = 100; // 60 Google Ads + 40 Other
const R1_OTHER_COUNT = 40;
const R1_OTHER_MISSED = 10;
const R1_ADS_MISSED = 12;
// missedCallRate (Task #2680): allLeadQuality sums ACTIVE products only
// (google_ads → 12; the parsed GBP block was deleted by the gate), Other's
// missed calls fold into the numerator, then hide ON removes Other from both
// sides → (12 + 10 − 10) / (100 − 40) = 12/60 = 20.0%.
const R1_EXPECTED_MISSED_CALL_RATE = 20;

// Round 2 (UPSERT into the SAME report): different raw numbers so a stale
// round-1 value can't fake a pass.
const R2_RAW_TOTAL = 90; // 60 Google Ads + 30 Other
const R2_OTHER_COUNT = 30;
const R2_OTHER_MISSED = 6;
const R2_ADS_MISSED = 9;
// (9 + 6 − 6) / (90 − 30) = 9/60 = 15.0%.
const R2_EXPECTED_MISSED_CALL_RATE = 15;

// Rounds 3–4 (Task #4983 write-path preservation): payloads whose quality
// buckets carry ZERO missed calls (structural defaults — the client's call
// reporting pushed nothing).
//   Round 3: no parsed headline rate either → the re-import must PRESERVE
//   the previously stored pushed rate instead of stamping a recomputed 0.
//   Round 4: the parsed intake DOES carry a pushed headline rate → that
//   pushed value wins (clamped), replacing the older prior.
const PUSHED_PRIOR_RATE = 9.5; // planted as the stored pushed rate before round 3
const R4_PARSED_PUSHED_RATE = 22.5;

type CreateFn = typeof openai.chat.completions.create;
const ORIGINAL_CREATE: CreateFn = openai.chat.completions.create.bind(
  openai.chat.completions,
);

function mockOpenAiThrows(): void {
  (openai.chat.completions as any).create = async () => {
    throw new Error("simulated AI outage (task-2817)");
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
    // authenticates as that user id. This suite only exercises the webhook
    // import route (token-authed, not requireAuth-gated), so the seam is set
    // for parity but no users row / registry entry is needed.
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
  const pdf = Buffer.from("%PDF-1.4 task-2817 synthetic pdf").toString("base64");
  return { clientId: CLIENT_ID, reportMonth: REPORT_MONTH, pdf };
}

/**
 * A parsed payload whose grand total INCLUDES the Other bucket, with a GBP
 * location the Active-Products gate must delete (client owns google_ads only).
 */
function parsedPayload(round: 1 | 2 | 3 | 4): any {
  // Rounds 3–4: all-zero missed-call buckets (no call-tracking data pushed).
  // Round 4 additionally carries a pushed headline rate in the parsed intake.
  const total = round === 1 ? R1_RAW_TOTAL : R2_RAW_TOTAL;
  const other = round === 1 ? R1_OTHER_COUNT : R2_OTHER_COUNT;
  const otherMissed = round === 1 ? R1_OTHER_MISSED : round === 2 ? R2_OTHER_MISSED : 0;
  const adsMissed = round === 1 ? R1_ADS_MISSED : round === 2 ? R2_ADS_MISSED : 0;
  return {
    intake: {
      totalConsults: 6,
      commonIssues: "",
      ...(round === 4 ? { missedCallRate: R4_PARSED_PUSHED_RATE } : {}),
    },
    sales: { commonIssues: "" },
    marketing: {
      totalLeads: total,
      // Inactive-product block: the client does NOT own gbp, so the
      // Active-Products gate deletes this before persist. Its presence is
      // the point — deletion must not disturb totalLeads / otherLeads.
      gbpLocations: [
        {
          name: "Lehi",
          uniqueLeads: 25,
          reviewsGenerated: 2,
          leadQuality: { good: 15, notQuotable: 3, missedCalls: 7, noData: 0 },
        },
      ],
      googleAds: {
        uniqueLeads: 60,
        adSpend: 3000,
        leadQuality: { good: 40, notQuotable: 8, missedCalls: adsMissed, noData: 0 },
      },
      otherLeads: {
        total: other,
        socialMedia: other,
        leadQuality: { good: 0, notQuotable: 0, missedCalls: otherMissed, noData: 0 },
      },
    },
  };
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
  // hide_other_leads = true AND products WITHOUT 'gbp' — the whole point of
  // the scenario: the Active-Products gate deletes the parsed GBP blocks
  // before the marketing section is built.
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products, hide_other_leads)
    VALUES (${CLIENT_ID}, ${"Hide Other Webhook NoGbp Firm"}, ARRAY['google_ads']::text[], true)
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

async function run(): Promise<void> {
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await seed(isoDb);
        mockOpenAiThrows();

        let round: 1 | 2 | 3 | 4 = 1;
        __setParseReportPdf(async () => parsedPayload(round));

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          // ── Round 1: webhook CREATE for the no-gbp hide-Other client ──
          const r1 = await postWebhook(baseUrl);
          assert.equal(
            r1.status,
            201,
            `round 1: expected 201, got ${r1.status} body=${JSON.stringify(r1.body)}`,
          );
          const reportId = r1.body.reportId as string;
          assert.ok(reportId, "round 1: webhook response must carry reportId");

          const m1 = await readSectionData(isoDb, reportId, "marketing");
          assert.ok(m1, "round 1: persisted marketing section must exist");
          assert.equal(
            m1.totalLeads,
            R1_RAW_TOTAL,
            "INVARIANT (create, no gbp): persisted totalLeads must be the raw total INCLUDING Other — the Active-Products deletion of the inactive GBP block must never take the grand total down with it",
          );
          assert.equal(
            m1.otherLeads?.count,
            R1_OTHER_COUNT,
            "INVARIANT (create, no gbp): persisted otherLeads.count must be preserved so display-time subtraction has its operand",
          );
          // Prove the no-gbp branch actually ran: the gate deleted the parsed
          // GBP location, so the persisted gbp block is empty and the GBP
          // lead-quality rollup is all zeros.
          assert.deepEqual(
            m1.gbp?.locations ?? [],
            [],
            "round 1: parsed GBP location must have been dropped by the Active-Products gate (client does not own gbp)",
          );
          assert.equal(
            (m1.gbpLeadQuality?.good || 0) +
              (m1.gbpLeadQuality?.notQuotable || 0) +
              (m1.gbpLeadQuality?.missedCalls || 0) +
              (m1.gbpLeadQuality?.noData || 0),
            0,
            "round 1: gbpLeadQuality must be all zeros for a no-gbp client",
          );

          const i1 = await readSectionData(isoDb, reportId, "intake");
          assert.ok(i1, "round 1: persisted intake section must exist");
          assert.equal(
            i1.missedCallRate,
            R1_EXPECTED_MISSED_CALL_RATE,
            `round 1: missedCallRate is the ONLY persist-time hide application — (12+10−10)/(100−40) = 20%, got ${i1.missedCallRate}`,
          );

          // ── Round 2: webhook UPSERT into the SAME (client, month) report ──
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
            "round 2: webhook upsert policy must REUSE the existing report id for the same client + month",
          );

          // Exactly one report row — the upsert branch, not a duplicate.
          const reportRows: any = await isoDb.execute(sql`
            SELECT id FROM reports
            WHERE client_id = ${CLIENT_ID} AND report_month = ${REPORT_MONTH}
          `);
          const reportList = Array.isArray(reportRows) ? reportRows : reportRows?.rows;
          assert.equal(
            reportList?.length,
            1,
            `round 2: exactly one report row must exist for the month, got ${reportList?.length}`,
          );

          const m2 = await readSectionData(isoDb, reportId, "marketing");
          assert.ok(m2, "round 2: persisted marketing section must exist");
          assert.equal(
            m2.totalLeads,
            R2_RAW_TOTAL,
            "INVARIANT (upsert overwrite): the overwritten marketing section must carry the NEW payload's raw total INCLUDING Other — the unattended overwrite path must never pre-suppress",
          );
          assert.equal(
            m2.otherLeads?.count,
            R2_OTHER_COUNT,
            "INVARIANT (upsert overwrite): the overwritten otherLeads.count must be the new payload's raw Other count",
          );

          const i2 = await readSectionData(isoDb, reportId, "intake");
          assert.ok(i2, "round 2: persisted intake section must exist");
          assert.equal(
            i2.missedCallRate,
            R2_EXPECTED_MISSED_CALL_RATE,
            `round 2: missedCallRate recomputed from the new payload — (9+6−6)/(90−30) = 15%, got ${i2.missedCallRate}`,
          );

          // ── Round 3 (Task #4983): re-import with NO missed-call data must
          // preserve a stored pushed rate, never stamp a recomputed 0 ──
          // Plant a pushed rate (as if the client's call report supplied the
          // headline number without per-bucket detail).
          await isoDb.execute(sql`
            UPDATE report_sections
            SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{missedCallRate}', ${JSON.stringify(PUSHED_PRIOR_RATE)}::jsonb)
            WHERE report_id = ${reportId} AND section_key = ${"intake"}
          `);
          round = 3;
          const r3 = await postWebhook(baseUrl);
          assert.equal(
            r3.status,
            201,
            `round 3: expected 201, got ${r3.status} body=${JSON.stringify(r3.body)}`,
          );
          const i3 = await readSectionData(isoDb, reportId, "intake");
          assert.equal(
            i3.missedCallRate,
            PUSHED_PRIOR_RATE,
            `INVARIANT (Task #4983): a webhook re-import whose buckets carry ZERO missed calls (structural defaults) and no parsed headline rate must PRESERVE the stored pushed rate — got ${i3.missedCallRate}`,
          );
          // The rest of the overwrite still happened (this is a preservation
          // of one field, not a skipped import).
          assert.equal(
            i3.totalConsults,
            6,
            "round 3: the intake overwrite itself still applied (only the rate was preserved)",
          );

          // ── Round 4 (Task #4983): a parsed PUSHED headline rate wins over
          // the prior even with all-zero buckets ──
          round = 4;
          const r4 = await postWebhook(baseUrl);
          assert.equal(
            r4.status,
            201,
            `round 4: expected 201, got ${r4.status} body=${JSON.stringify(r4.body)}`,
          );
          const i4 = await readSectionData(isoDb, reportId, "intake");
          assert.equal(
            i4.missedCallRate,
            R4_PARSED_PUSHED_RATE,
            `round 4: a pushed headline rate in the parsed intake displaces the prior (tier 2), got ${i4.missedCallRate}`,
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

    console.log("hide-other-leads-webhook-upsert-no-gbp: PASSED");
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
    console.error("hide-other-leads-webhook-upsert-no-gbp: FAILED", err);
    process.exitCode = 1;
  });
