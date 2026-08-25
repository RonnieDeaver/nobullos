/* test-registration
{
  "name": "Reports JSONB corruption alert — real route, real row IDs, no stored content (Task #4197)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy isolated-schema route test (clones 4 tables, boots a real Express server + pinGetDbForCrossAsync); the fast DB-free companion tests/report-jsonb-corruption-alerts.test.ts already gates the alert wiring in the routine smoke run — this suite guards the call-site context threading in the nightly sweep.",
  "tier": "small"
}
test-registration */
/**
 * Task #4197 (review follow-through) — the corruption alert must be
 * actionable from PRODUCTION call sites, not just when a test hands the
 * accessor a context by hand.
 *
 * This suite persists a genuinely malformed `report_sections.data` row
 * (a JSONB string scalar carrying a client-content sentinel) in an
 * isolated schema, fires a REAL request at
 * GET /api/reports/:id/sections (whose normalizeMarketingSectionKeys path
 * decodes each section through readMarketingSection with the row's own
 * ids), and asserts:
 *
 *   (A) exactly one alert dispatch, dedupeKey report_jsonb_malformed:<boundary>;
 *   (B) the alert body names the REAL section id and report id from the DB
 *       row — never "row id not captured";
 *   (C) the stored value (client-content sentinel) appears NOWHERE in the
 *       alert title/message/dedupeKey;
 *   (D) the route itself still responds 200 with the safe fallback (the
 *       malformed row degrades, it does not 500).
 *
 * Runs with pinGetDbForCrossAsync so the Express handlers (outside the
 * sandbox's ALS scope) read the cloned tables, not live public.*.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import {
  REPORT_JSONB_ALERT_DEDUPE_PREFIX,
  REPORT_JSONB_ALERT_NOTIFICATION_ID,
  __resetReportJsonbCorruptionAlertsForTest,
  __setReportJsonbAlertNotifyForTest,
  __drainReportJsonbAlertsForTest,
  installReportJsonbCorruptionAlerts,
} from "../server/services/reportJsonbCorruptionAlerts";
import { runInIsolatedSchema } from "./db-sandbox";

const TAG = `rjc-route-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const USER_ID = `user-${TAG}`;
const CLIENT_ID = `client-${TAG}`;
const REPORT_ID = `report-${TAG}`;
// Sentinel that must never leak into the alert body — it stands in for
// client content stored in the corrupted JSONB value.
const PII_SENTINEL = `SENSITIVE-CLIENT-CONTENT-${TAG}`;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = USER_ID;
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

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await isoDb.execute(sql`
        INSERT INTO users (id, email, first_name, last_name)
        VALUES (${USER_ID}, ${`${USER_ID}@example.com`}, 'Route', 'Tester')
      `);
      // Seeded in the isolated (uncommitted) schema, invisible to requireAuth's
      // ambient public-schema lookup. Pre-register so the real middleware admits
      // the user without JIT-provisioning a public row.
      __test_markUserReconciled(USER_ID, {
        id: USER_ID,
        email: `${USER_ID}@example.com`,
        firstName: "Route",
        lastName: "Tester",
      });
      await isoDb.execute(sql`
        INSERT INTO clients (id, firm_name) VALUES (${CLIENT_ID}, ${`Firm ${TAG}`})
      `);
      await isoDb.execute(sql`
        INSERT INTO reports (id, client_id, report_month, status, created_by)
        VALUES (${REPORT_ID}, ${CLIENT_ID}, ${"2026-03"}, ${"draft"}, ${USER_ID})
      `);
      // Malformed row: report_sections.data is a JSONB STRING scalar, not an
      // object — exactly the corruption class F5 typed accessors guard.
      const sectionRes: any = await isoDb.execute(sql`
        INSERT INTO report_sections (report_id, section_key, data)
        VALUES (${REPORT_ID}, ${"marketing"}, to_jsonb(${PII_SENTINEL}::text))
        RETURNING id
      `);
      const sectionRows = Array.isArray(sectionRes) ? sectionRes : sectionRes?.rows ?? [];
      const SECTION_ID = String(sectionRows[0].id);

      const dispatched: Array<{ type: string; payload: any; options: any }> = [];
      installReportJsonbCorruptionAlerts();
      __resetReportJsonbCorruptionAlertsForTest();
      __setReportJsonbAlertNotifyForTest(async (type, payload, options) => {
        dispatched.push({ type, payload, options });
        return { outcome: "delivered" } as any;
      });

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        const res = await fetch(`${baseUrl}/api/reports/${REPORT_ID}/sections`);
        const body = await res.json();
        await __drainReportJsonbAlertsForTest();

        // (D) Route degrades safely, never 500s on the corrupt row.
        assert.equal(res.status, 200, "route responds 200 despite malformed section data");
        assert.ok(Array.isArray(body), "sections payload is still an array");
        console.log("  ok  (D) route returns 200 + safe fallback for the corrupt row");

        // (A) Exactly one dispatch with the registered id + boundary dedupeKey.
        assert.equal(dispatched.length, 1, `exactly one alert dispatch (got ${dispatched.length})`);
        const alert = dispatched[0];
        assert.equal(alert.type, REPORT_JSONB_ALERT_NOTIFICATION_ID, "registered notification id");
        assert.ok(
          String(alert.options?.dedupeKey).startsWith(REPORT_JSONB_ALERT_DEDUPE_PREFIX),
          "dedupeKey uses the boundary prefix",
        );
        console.log("  ok  (A) one dispatch, registered id, boundary dedupeKey");

        // (B) The alert names the REAL row ids captured at the route call site
        //     (both in the human text and the structured metadata).
        const text = String(alert.payload.text ?? "");
        assert.ok(text.includes(SECTION_ID), `alert body names the real section id (${SECTION_ID})`);
        assert.ok(text.includes(REPORT_ID), "alert body names the real report id");
        assert.ok(
          !/row id not captured/i.test(text),
          "alert must NOT fall back to 'row id not captured' from a real route",
        );
        assert.equal(alert.options?.metadata?.sampleSectionId, SECTION_ID, "metadata sampleSectionId is the real row id");
        assert.equal(alert.options?.metadata?.sampleReportId, REPORT_ID, "metadata sampleReportId is the real report id");
        console.log("  ok  (B) alert carries the real section + report ids from the DB row");

        // (C) The stored value (client content) never leaks into the alert.
        const everything = JSON.stringify([alert.payload, alert.options]);
        assert.ok(
          !everything.includes(PII_SENTINEL),
          "stored-value sentinel must not appear anywhere in the alert payload",
        );
        console.log("  ok  (C) stored client content stays out of the alert body");
      } finally {
        server.close();
        __setReportJsonbAlertNotifyForTest(null);
        __resetReportJsonbCorruptionAlertsForTest();
      }
    },
    {
      tables: ["users", "clients", "reports", "report_sections"],
      pinGetDbForCrossAsync: true,
    },
  ).finally(() => {
    __test_resetReconciledUsers();
  });
}

main().then(
  () => {
    console.log("report-jsonb-corruption-route-alert: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("report-jsonb-corruption-route-alert: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
