/* test-registration
{
  "name": "Webinar lead-quality breakdown: derivation priority + edit round-trip (Task #2839)",
  "regression": true,
  "sweepOnlyReason": "Task #2839 — derivation priority (pure logic) + edit round-trip (section PUT + GET); real db + runInIsolatedSchema writes (DB-heavy), so not a smoke-gate candidate. Mirrors the hide-other-leads peer entries.",
  "tier": "small"
}
test-registration */
/**
 * Task #2839 — Webinar lead-quality breakdown: derivation priority + edit round-trip.
 *
 * Bug: editing Hot Transfers left the report's `webinar.leadQuality` breakdown
 * stale, so the breakdown sum (which takes priority over Hot Transfers × 1.6)
 * continued to drive all lead totals at the old value.
 *
 * Fix: the Webinars card in the editor now exposes the four lead-quality
 * breakdown fields as editable inputs, and shows a mismatch warning when the
 * breakdown sum differs from Hot Transfers.
 *
 * This test locks three invariants:
 *   1. Derivation priority: breakdown sum wins when > 0; falls back to
 *      Math.ceil(hotTransfers × 1.6) when breakdown is all zeros.
 *   2. Edit round-trip: PUT /api/reports/:id/sections/marketing with a
 *      webinar.leadQuality update persists the new values; a subsequent GET
 *      on the marketing section returns them unchanged.
 *   3. Total-leads equivalency (Task #4511): the report total adds webinar
 *      LEAD EQUIVALENTS (ceil(count × 1.6) in breakdown mode), not the raw
 *      breakdown count — matching the Marketing annotation, lead-source pie,
 *      and trend-chart convention. In fallback mode equiv === count (already
 *      ceil(HT × 1.6)), so Hot Transfers-only clients are unchanged.
 */

// Clerk-era per-request auth seam (see server/middlewares/requireAuth.ts):
// only honored when NODE_ENV=test; self-set so bare repros behave like the
// runner (which refuses non-hermetic DBs anyway).
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { registerReportRoutes } from "../server/routes/reports";
import { runInIsolatedSchema, sql } from "./db-sandbox";

const TAG = `task-2839-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `${TAG}-actor`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const REPORT_MONTH = "2026-05";

const WEBINAR_LEAD_EQUIVALENCY = 1.6;

// ── Pure derivation logic (mirrors ReportForm.tsx and publicReport/derive.ts) ──

function webinarLeadCount(opts: {
  hotTransfers: number;
  leadQuality: { good: number; notQuotable: number; missedCalls: number; noData: number };
  hasWebinar: boolean;
}): number {
  if (!opts.hasWebinar) return 0;
  const lqSum =
    opts.leadQuality.good +
    opts.leadQuality.notQuotable +
    opts.leadQuality.missedCalls +
    opts.leadQuality.noData;
  if (lqSum > 0) return lqSum;
  return Math.ceil(opts.hotTransfers * WEBINAR_LEAD_EQUIVALENCY);
}

// Task #4511 — mirrors the webinarLeadEquiv derivation: in breakdown mode the
// equivalent is ceil(count × 1.6); in fallback mode the count IS already the
// equivalent (ceil(HT × 1.6)), so equiv === count.
function webinarLeadEquiv(opts: {
  hotTransfers: number;
  leadQuality: { good: number; notQuotable: number; missedCalls: number; noData: number };
  hasWebinar: boolean;
}): number {
  const count = webinarLeadCount(opts);
  if (!opts.hasWebinar || count === 0) return 0;
  const lqSum =
    opts.leadQuality.good +
    opts.leadQuality.notQuotable +
    opts.leadQuality.missedCalls +
    opts.leadQuality.noData;
  return lqSum > 0 ? Math.ceil(count * WEBINAR_LEAD_EQUIVALENCY) : count;
}

// Task #4511 — mirrors the totalLeads / calculatedTotalLeads formula in
// publicReport/derive.ts and ReportForm.tsx: non-webinar leads + webinar lead
// EQUIVALENTS (never the raw breakdown count).
function reportTotalLeads(opts: {
  totalLeadsExcludingWebinar: number;
  hotTransfers: number;
  leadQuality: { good: number; notQuotable: number; missedCalls: number; noData: number };
  hasWebinar: boolean;
}): number {
  return opts.totalLeadsExcludingWebinar + webinarLeadEquiv(opts);
}

// ── Derivation priority tests (no server, no DB) ─────────────────────────────

function testDerivationPriority() {
  const zeroLQ = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

  // When breakdown is all zeros → fallback to Math.ceil(hotTransfers × 1.6)
  assert.equal(
    webinarLeadCount({ hotTransfers: 29, leadQuality: zeroLQ, hasWebinar: true }),
    Math.ceil(29 * 1.6),
    "zero breakdown falls back to Math.ceil(hotTransfers × 1.6)",
  );

  // When breakdown sums to > 0 → breakdown wins regardless of hotTransfers
  const lq = { good: 20, notQuotable: 5, missedCalls: 3, noData: 1 };
  const lqSum = lq.good + lq.notQuotable + lq.missedCalls + lq.noData;
  assert.equal(
    webinarLeadCount({ hotTransfers: 44, leadQuality: lq, hasWebinar: true }),
    lqSum,
    "non-zero breakdown overrides hotTransfers (the stale-44 bug scenario)",
  );
  assert.notEqual(lqSum, Math.ceil(44 * 1.6), "sanity: lqSum and HT fallback differ");

  // After fixing breakdown to sum to hotTransfers → they agree
  const fixedLQ = { good: 29, notQuotable: 0, missedCalls: 0, noData: 0 };
  assert.equal(
    webinarLeadCount({ hotTransfers: 29, leadQuality: fixedLQ, hasWebinar: true }),
    29,
    "after correction breakdown sum equals hotTransfers; count is 29 not 29×1.6",
  );

  // Clearing breakdown (all zeros) re-enables the hotTransfers fallback
  assert.equal(
    webinarLeadCount({ hotTransfers: 29, leadQuality: zeroLQ, hasWebinar: true }),
    Math.ceil(29 * 1.6),
    "clearing breakdown falls back to hotTransfers fallback",
  );

  // hasWebinar=false always yields 0
  assert.equal(
    webinarLeadCount({ hotTransfers: 50, leadQuality: lq, hasWebinar: false }),
    0,
    "no webinar product → 0",
  );

  console.log("  [ok] derivation priority: breakdown sum wins; fallback to HT × 1.6 when zero");
}

// ── Total-leads equivalency tests (Task #4511, no server, no DB) ─────────────

function testTotalLeadsEquivalency() {
  const zeroLQ = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };

  // Reporter's scenario (client fff49295…): 233 non-webinar leads plus a
  // webinar breakdown summing to 2. The Marketing slide annotates
  // "2 webinar leads (4 lead equiv.)" — the report total must be
  // 233 + 4 = 237, NOT 233 + 2 = 235 (the regression this task fixes).
  const reporterLQ = { good: 2, notQuotable: 0, missedCalls: 0, noData: 0 };
  const reporter = {
    totalLeadsExcludingWebinar: 233,
    hotTransfers: 0,
    leadQuality: reporterLQ,
    hasWebinar: true,
  };
  assert.equal(webinarLeadCount(reporter), 2, "breakdown sum is the raw count (2)");
  assert.equal(
    webinarLeadEquiv(reporter),
    Math.ceil(2 * WEBINAR_LEAD_EQUIVALENCY),
    "breakdown mode equivalent is ceil(2 × 1.6) = 4",
  );
  assert.equal(
    reportTotalLeads(reporter),
    237,
    "breakdown mode total = excluding (233) + equiv (4) = 237, never raw 235",
  );
  assert.notEqual(
    reportTotalLeads(reporter),
    233 + webinarLeadCount(reporter),
    "sanity: the equiv-inclusive total differs from the raw-count total here",
  );

  // Fallback mode (Hot Transfers only, zero breakdown): the count is ALREADY
  // the equivalent — ceil(HT × 1.6) — so equiv === count and the total is
  // provably unchanged from the pre-#4511 formula (excluding + count).
  const fallback = {
    totalLeadsExcludingWebinar: 100,
    hotTransfers: 29,
    leadQuality: zeroLQ,
    hasWebinar: true,
  };
  assert.equal(
    webinarLeadEquiv(fallback),
    webinarLeadCount(fallback),
    "fallback mode: equiv === count (both ceil(29 × 1.6) = 47)",
  );
  assert.equal(
    reportTotalLeads(fallback),
    100 + webinarLeadCount(fallback),
    "fallback mode total identical to the old excluding + count formula",
  );
  assert.equal(reportTotalLeads(fallback), 147, "fallback total = 100 + 47");

  // No webinar product: total is just the non-webinar sum, regardless of any
  // stray webinar data.
  assert.equal(
    reportTotalLeads({
      totalLeadsExcludingWebinar: 50,
      hotTransfers: 10,
      leadQuality: reporterLQ,
      hasWebinar: false,
    }),
    50,
    "no webinar product → total = excluding only",
  );

  // Breakdown mode with a sum that matches Hot Transfers still converts to
  // equivalents for the total (count 29 → equiv ceil(29 × 1.6) = 47).
  const corrected = {
    totalLeadsExcludingWebinar: 200,
    hotTransfers: 29,
    leadQuality: { good: 29, notQuotable: 0, missedCalls: 0, noData: 0 },
    hasWebinar: true,
  };
  assert.equal(webinarLeadCount(corrected), 29, "breakdown sum 29 wins as the count");
  assert.equal(
    reportTotalLeads(corrected),
    200 + Math.ceil(29 * WEBINAR_LEAD_EQUIVALENCY),
    "breakdown total uses ceil(29 × 1.6) = 47, not the raw 29",
  );

  console.log("  [ok] total-leads equivalency: totals add webinar equivalents; fallback unchanged");
}

// ── Server-route round-trip test ─────────────────────────────────────────────

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk-era per-request test seam (replaces the dead passport-shape
    // injection): requireAuth resolves this id against the users row seeded
    // in the isolated schema.
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

function initialMarketing(): Record<string, unknown> {
  return {
    totalLeads: 70,
    webinar: {
      registrants: 100,
      attendees: 60,
      hotTransfers: 44,
      leadQuality: { good: 44, notQuotable: 0, missedCalls: 0, noData: 0 },
    },
  };
}

async function seed(isoDb: any): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO users (id, role, email, first_name, last_name)
    VALUES (${ACTOR_ID}, 'ceo', ${`${ACTOR_ID}@example.com`}, 'Webinar', 'Tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products)
    VALUES (${CLIENT_ID}, ${"Webinar Test Firm"}, ARRAY['webinar']::text[])
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, ${REPORT_MONTH}, 'draft', ${ACTOR_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES (${REPORT_ID}, 'marketing', ${JSON.stringify(initialMarketing())}::jsonb)
    ON CONFLICT (report_id, section_key) DO UPDATE SET data = EXCLUDED.data
  `);
}

async function testRoundTrip() {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    await seed(isoDb);

    const app = buildApp();
    const { server, baseUrl } = await listen(app);

    try {
      // Step 1: operator edits the webinar leadQuality to correct the stale 44→29
      const updatedMarketing = {
        ...initialMarketing(),
        webinar: {
          registrants: 100,
          attendees: 60,
          hotTransfers: 29,
          leadQuality: { good: 20, notQuotable: 5, missedCalls: 3, noData: 1 },
        },
      };

      const putRes = await fetch(`${baseUrl}/api/reports/${REPORT_ID}/sections/marketing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: updatedMarketing, editSource: "ui_edit" }),
      });
      assert.equal(putRes.status, 200, `PUT returned ${putRes.status}`);

      // Step 2: verify the saved data via GET /api/reports/:id
      const getRes = await fetch(`${baseUrl}/api/reports/${REPORT_ID}`);
      assert.equal(getRes.status, 200, `GET returned ${getRes.status}`);
      const report = await getRes.json() as any;

      const sections: any[] = report.sections || [];
      const mkt = sections.find((s: any) => s.sectionKey === "marketing");
      assert.ok(mkt, "marketing section present in response");

      const savedWebinar = mkt.data?.webinar;
      assert.ok(savedWebinar, "webinar block present in saved marketing data");

      assert.equal(savedWebinar.hotTransfers, 29, "hotTransfers persisted correctly");
      assert.equal(savedWebinar.leadQuality?.good, 20, "leadQuality.good persisted");
      assert.equal(savedWebinar.leadQuality?.notQuotable, 5, "leadQuality.notQuotable persisted");
      assert.equal(savedWebinar.leadQuality?.missedCalls, 3, "leadQuality.missedCalls persisted");
      assert.equal(savedWebinar.leadQuality?.noData, 1, "leadQuality.noData persisted");

      // Step 3: confirm the derivation from the saved data now uses the breakdown sum
      const savedLqSum =
        savedWebinar.leadQuality.good +
        savedWebinar.leadQuality.notQuotable +
        savedWebinar.leadQuality.missedCalls +
        savedWebinar.leadQuality.noData;
      assert.equal(savedLqSum, 29, "saved breakdown sums to 29 (matches new hotTransfers)");
      assert.equal(
        webinarLeadCount({
          hotTransfers: savedWebinar.hotTransfers,
          leadQuality: savedWebinar.leadQuality,
          hasWebinar: true,
        }),
        29,
        "derivation after edit: breakdown sum (29) wins, not HT × 1.6",
      );

      console.log("  [ok] edit round-trip: webinar.leadQuality persists and derivation agrees");
    } finally {
      await closeServer(server);
      await getGlobalDispatcher().close();
    }
  });
}

async function main() {
  console.log("webinar-lead-quality-edit: derivation priority + edit round-trip");

  console.log("  running derivation priority checks ...");
  testDerivationPriority();

  console.log("  running total-leads equivalency checks (Task #4511) ...");
  testTotalLeadsEquivalency();

  console.log("  running edit round-trip (server + isolated DB) ...");
  await testRoundTrip();

  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
