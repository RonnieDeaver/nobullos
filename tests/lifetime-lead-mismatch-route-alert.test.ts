/* test-registration
{
  "name": "Lifetime lead mismatch alert — real share route, seeded inconsistent rows (Task #4637)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy isolated-schema route test (clones 6 tables, boots a real Express server + pinGetDbForCrossAsync, walks the full buildReportResponse payload assembly); the fast DB-free companion tests/lifetime-lead-mismatch-alerts.test.ts already gates the check's formula/dedupe wiring in the routine smoke run — this suite guards the GET /api/share/:token call-site threading in the nightly sweep, mirroring the #4197 route twin.",
  "tier": "small"
}
test-registration */
/**
 * Task #4637 — the Task #4620 serve-time lifetime-vs-monthly lead mismatch
 * check must be actionable from the PRODUCTION call site, not just when the
 * DB-free suite hands checkLifetimeLeadMismatch an input by hand.
 *
 * This suite seeds (isolated schema) a client with three monthly reports
 * whose marketing sections make the served trend window's per-source lead
 * sum EXCEED lifetimeValue.totalLeads — the realistic "edited month"
 * corruption: a report AFTER the shared month carries a negative
 * uniqueLeads, dragging the lifetime cumulative sum below the window sum
 * (lifetime iterates ALL reports; the trend window stops at the shared
 * report). It then fires REAL requests at GET /api/share/:token and asserts:
 *
 *   (A) the share route still serves 200 with the full payload (the
 *       inconsistent data degrades the slide, it never breaks the serve),
 *       and the served numbers are exactly the mismatch we seeded;
 *   (B) exactly ONE alert dispatch with the registered notification id and
 *       dedupeKey lifetime_lead_mismatch:<reportId>;
 *   (C) the alert body + metadata carry the REAL report/client ids and the
 *       two real numbers from the served payload;
 *   (D) a second view of the same share link inside the re-alert window
 *       dispatches NOTHING further (per-report throttle) — "alerts once".
 *
 * Runs with pinGetDbForCrossAsync so the Express handlers (outside the
 * sandbox's ALS scope) read the cloned tables, not live public.*.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import {
  LIFETIME_LEAD_MISMATCH_NOTIFICATION_ID,
  LIFETIME_LEAD_MISMATCH_DEDUPE_PREFIX,
  __setLifetimeLeadMismatchNotifyForTest,
  __resetLifetimeLeadMismatchAlertsForTest,
  __drainLifetimeLeadMismatchAlertsForTest,
} from "../server/services/lifetimeLeadMismatchAlerts";
import { runInIsolatedSchema } from "./db-sandbox";

const TAG = `llm-route-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = `client-${TAG}`;
const REPORT_JAN = `report-jan-${TAG}`;
const REPORT_FEB = `report-feb-${TAG}`; // the shared report
const REPORT_MAR = `report-mar-${TAG}`; // the corrupted later month
const SHARE_TOKEN = `share-${TAG}`;

// Seeded per-source leads: the trend window (Jan + Feb) sums to 100 via
// googleAds.uniqueLeads, while the lifetime cumulative sum also folds in
// March's corrupted -50 → lifetimeValue.totalLeads = 50 < windowTotal = 100.
const JAN_LEADS = 40;
const FEB_LEADS = 60;
const MAR_LEADS = -50;
const EXPECTED_WINDOW_TOTAL = JAN_LEADS + FEB_LEADS; // 100
const EXPECTED_LIFETIME_TOTAL = JAN_LEADS + FEB_LEADS + MAR_LEADS; // 50

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // Client with no owner (skips the account-manager user lookup) and no
      // practice areas (skips the seasonal-trend embed) — the mismatch check
      // is the surface under test, everything else stays inert.
      await isoDb.execute(sql`
        INSERT INTO clients (id, firm_name) VALUES (${CLIENT_ID}, ${`Firm ${TAG}`})
      `);
      await isoDb.execute(sql`
        INSERT INTO reports (id, client_id, report_month, status, share_token)
        VALUES
          (${REPORT_JAN}, ${CLIENT_ID}, ${"2026-01"}, ${"final"}, NULL),
          (${REPORT_FEB}, ${CLIENT_ID}, ${"2026-02"}, ${"final"}, ${SHARE_TOKEN}),
          (${REPORT_MAR}, ${CLIENT_ID}, ${"2026-03"}, ${"draft"}, NULL)
      `);
      const section = (leads: number) =>
        JSON.stringify({ googleAds: { uniqueLeads: leads } });
      await isoDb.execute(sql`
        INSERT INTO report_sections (report_id, section_key, data)
        VALUES
          (${REPORT_JAN}, ${"marketing"}, ${section(JAN_LEADS)}::jsonb),
          (${REPORT_FEB}, ${"marketing"}, ${section(FEB_LEADS)}::jsonb),
          (${REPORT_MAR}, ${"marketing"}, ${section(MAR_LEADS)}::jsonb)
      `);

      const dispatched: Array<{ type: string; payload: any; options: any }> = [];
      __resetLifetimeLeadMismatchAlertsForTest();
      __setLifetimeLeadMismatchNotifyForTest(async (type: any, payload: any, options: any) => {
        dispatched.push({ type, payload, options });
        return { outcome: "delivered" } as any;
      });

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        const res = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
        const body: any = await res.json();
        await __drainLifetimeLeadMismatchAlertsForTest();

        // (A) The share route still serves the report despite the mismatch,
        //     and the served payload carries exactly the inconsistent numbers
        //     we seeded (proving the check saw the REAL served values).
        assert.equal(res.status, 200, "share route responds 200 despite the lifetime mismatch");
        assert.equal(
          body?.lifetimeValue?.totalLeads,
          EXPECTED_LIFETIME_TOTAL,
          "served lifetimeValue.totalLeads is the corrupted cumulative sum",
        );
        assert.ok(Array.isArray(body?.trendData) && body.trendData.length === 2, "trendData serves both window months");
        const servedWindowTotal = body.trendData.reduce(
          (sum: number, m: any) => sum + (m?.marketing?.leadsBySource?.googleAds || 0),
          0,
        );
        assert.equal(servedWindowTotal, EXPECTED_WINDOW_TOTAL, "served trend window sums to the seeded per-source total");
        console.log("  ok  (A) share route serves 200 with the seeded inconsistent payload");

        // (B) Exactly one dispatch, registered id, per-report dedupeKey.
        assert.equal(dispatched.length, 1, `exactly one alert dispatch (got ${dispatched.length})`);
        const alert = dispatched[0];
        assert.equal(alert.type, LIFETIME_LEAD_MISMATCH_NOTIFICATION_ID, "registered notification id");
        assert.equal(
          alert.options?.dedupeKey,
          `${LIFETIME_LEAD_MISMATCH_DEDUPE_PREFIX}${REPORT_FEB}`,
          "dedupeKey is lifetime_lead_mismatch:<real report id>",
        );
        console.log("  ok  (B) one dispatch, registered id, per-report dedupeKey");

        // (C) Real ids + real numbers in both the human text and metadata.
        const text = String(alert.payload?.text ?? "");
        assert.ok(text.includes(REPORT_FEB), "alert body names the real report id");
        assert.ok(text.includes(CLIENT_ID), "alert body names the real client id");
        assert.ok(text.includes(String(EXPECTED_WINDOW_TOTAL)), "alert body carries the window total");
        assert.ok(text.includes(String(EXPECTED_LIFETIME_TOTAL)), "alert body carries the lifetime headline");
        assert.equal(alert.options?.metadata?.reportId, REPORT_FEB, "metadata reportId is the real report id");
        assert.equal(alert.options?.metadata?.clientId, CLIENT_ID, "metadata clientId is the real client id");
        assert.equal(alert.options?.metadata?.reportMonth, "2026-02", "metadata reportMonth is the shared month");
        assert.equal(alert.options?.metadata?.totalLeads, EXPECTED_LIFETIME_TOTAL, "metadata totalLeads matches the served headline");
        assert.equal(alert.options?.metadata?.trendWindowLeadTotal, EXPECTED_WINDOW_TOTAL, "metadata trendWindowLeadTotal matches the served window sum");
        console.log("  ok  (C) alert carries the real report/client ids and both real numbers");

        // (D) A hot share link alerts ONCE: a second view inside the
        //     re-alert window serves 200 again but dispatches nothing more.
        const res2 = await fetch(`${baseUrl}/api/share/${SHARE_TOKEN}`);
        await res2.json();
        await __drainLifetimeLeadMismatchAlertsForTest();
        assert.equal(res2.status, 200, "second view still serves 200");
        assert.equal(dispatched.length, 1, "second view of the same report dispatches no further alert");
        console.log("  ok  (D) repeat view of the same share link alerts exactly once");
      } finally {
        server.close();
        __setLifetimeLeadMismatchNotifyForTest(null);
        __resetLifetimeLeadMismatchAlertsForTest();
        // Route tests that fetch a local express server can hang on exit via
        // undici's keep-alive sockets — close the global dispatcher.
        try {
          const { getGlobalDispatcher } = await import("undici");
          await getGlobalDispatcher().close();
        } catch {
          // best-effort
        }
      }
    },
    {
      // Every table buildReportResponse reads for this client must be cloned
      // (empty clones for the lookups that should find nothing), or the
      // isolated-schema search_path silently falls through to live public.*.
      tables: [
        "clients",
        "reports",
        "report_sections",
        "command_panels",
        "ceo_pulses",
        "client_data_access",
      ],
      pinGetDbForCrossAsync: true,
    },
  );
}

main().then(
  () => {
    console.log("lifetime-lead-mismatch-route-alert: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("lifetime-lead-mismatch-route-alert: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
