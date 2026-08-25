/* test-registration
{
  "name": "Service Desk reports route gate — 403/401/200 over real HTTP + report shape (Task #3121)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3121: route-level enforcement of the reporting API gate. Fires a REAL request at GET /api/service-desk/reports inside an isolated schema: account_manager → 403, unauthenticated → 401, team_lead → 200 with the full report shape (configured/volume/breakdowns/aging/commitment). This is the live counterpart to the source-only requireTeamLead assertion in service-desk-reports-smoke — it catches middleware reorder/removal that the source scan would miss.",
  "tier": "small"
}
test-registration */
/**
 * Task #3121 — Route-level regression guard for the reporting API gate.
 *
 * tests/service-desk-reports-smoke.test.ts only proves `requireTeamLead`
 * appears in the SOURCE of serviceDesk.ts — it never fires a real request,
 * so the gate could be accidentally weakened (middleware reordered, gate
 * dropped, requireRole loosened) without any test failing.
 *
 * This suite boots the real service-desk routes over HTTP inside an
 * isolated schema and asserts:
 *
 *   (A) An account_manager user gets 403 from GET /api/service-desk/reports.
 *   (B) An unauthenticated request gets 401.
 *   (C) A team_lead user gets 200 with the full report shape —
 *       configured:true plus volume / timeToResolve / breakdowns / aging /
 *       commitment / statusFlow keys — computed from seeded mirror rows.
 *
 * Runs with `pinGetDbForCrossAsync` so the Express handlers (outside the
 * sandbox's ALS scope) read the cloned tables, not live public.*.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { registerServiceDeskRoutes } from "../server/routes/serviceDesk";
import {
  sdListMapping,
  sdDepartments,
  sdTicketMapping,
  sdTicketEvents,
} from "@shared/schema";
import { clickupTasks } from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const LEAD_ID = "test-3121-lead";
const AM_ID = "test-3121-am";
const LIST_ID = "list-3121";
const DEPT_ID = "dept-3121-support";

const TABLES = [
  "users",
  "sd_list_mapping",
  "sd_departments",
  "sd_ticket_mapping",
  "sd_ticket_events",
  "clickup_tasks",
] as const;

// The auth middleware reads these closure variables so each request can
// present a different actor without re-registering routes.
let activeUserId: string | null = LEAD_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a
    // string authenticates as that user id; null models an anonymous
    // request (→ 401). Acting users are seeded in the isolated sandbox
    // schema, so pre-register their profiles via __test_markUserReconciled.
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerServiceDeskRoutes(app);
  return app;
}

async function listen(
  app: express.Express,
): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function getReports(baseUrl: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/service-desk/reports?days=30`);
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed actors ────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${LEAD_ID}, 'team_lead', 'Lead 3121')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${AM_ID}, 'account_manager', 'AM 3121')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Pre-register the acting users so requireAuth resolves them from the
      // sandbox seed instead of JIT-provisioning a public-schema row.
      __test_markUserReconciled(LEAD_ID, { id: LEAD_ID, role: "team_lead", firstName: "Lead 3121" });
      __test_markUserReconciled(AM_ID, { id: AM_ID, role: "account_manager", firstName: "AM 3121" });

      // ── Seed a configured list mapping + mirror data ───────────────────
      await db.insert(sdListMapping).values({
        clickupListId: LIST_ID,
        fieldDepartmentId: "cf-dept-3121",
        fieldRequestTypeId: "cf-rt-3121",
        fieldCommittedDateId: "cf-commit-3121",
        departmentOptionIds: { "opt-dept-support": DEPT_ID },
        requestTypeOptionIds: { "opt-rt-bug": "Bug Fix" },
        setupStep: "complete",
      });

      await db.insert(sdDepartments).values({ id: DEPT_ID, name: "Support" });

      const nowMs = Date.now();
      const DAY = 86_400_000;

      // Closed ticket: created 5d ago, done 1d ago, committed today → on-time.
      const closedCreated = nowMs - 5 * DAY;
      const closedDone = nowMs - 1 * DAY;
      await db.insert(clickupTasks).values({
        id: "task-3121-closed",
        listId: LIST_ID,
        name: "Closed on-time ticket",
        status: "Closed",
        dateCreated: String(closedCreated),
        dateDone: String(closedDone),
        priorityName: "High",
        customFields: [
          { id: "cf-dept-3121", value: "opt-dept-support" },
          { id: "cf-rt-3121", value: "opt-rt-bug" },
          { id: "cf-commit-3121", value: String(nowMs) },
        ],
      });

      // Open ticket: created 2d ago, no done date, committed 1d ago → overdue.
      // No dept/request-type fields → lands in the "Unmapped" buckets.
      await db.insert(clickupTasks).values({
        id: "task-3121-open",
        listId: LIST_ID,
        name: "Open overdue ticket",
        status: "In Progress",
        dateCreated: String(nowMs - 2 * DAY),
        customFields: [
          { id: "cf-commit-3121", value: String(nowMs - 1 * DAY) },
        ],
      });

      await db.insert(sdTicketMapping).values([
        { clickupTaskId: "task-3121-closed" },
        { clickupTaskId: "task-3121-open" },
      ]);

      // One committed-date slip event (in range).
      await db.insert(sdTicketEvents).values({
        clickupTaskId: "task-3121-open",
        eventType: "committed_date_change",
        data: { isMovingLater: true },
      });

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (A) account_manager → 403 ─────────────────────────────────────
        activeUserId = AM_ID;
        const amResp = await getReports(baseUrl);
        assert.equal(
          amResp.status,
          403,
          `account_manager must get 403 from /api/service-desk/reports (got ${amResp.status})`,
        );
        assert.equal(
          amResp.body?.error,
          "team_lead access required",
          "403 body must name the required role",
        );
        console.log("  ✓ A: account_manager rejected with 403");

        // ── (B) unauthenticated → 401 ─────────────────────────────────────
        activeUserId = null;
        const anonResp = await getReports(baseUrl);
        assert.equal(
          anonResp.status,
          401,
          `unauthenticated request must get 401 (got ${anonResp.status})`,
        );
        console.log("  ✓ B: unauthenticated request rejected with 401");

        // ── (C) team_lead → 200 with full report shape ────────────────────
        activeUserId = LEAD_ID;
        const leadResp = await getReports(baseUrl);
        assert.equal(
          leadResp.status,
          200,
          `team_lead must get 200 (got ${leadResp.status}: ${JSON.stringify(leadResp.body)})`,
        );
        const body = leadResp.body;
        assert.equal(body.configured, true, "report must be configured:true");

        // Shape keys
        for (const key of [
          "dateRange",
          "volume",
          "timeToResolve",
          "breakdowns",
          "aging",
          "oldestOpen",
          "commitment",
          "statusFlow",
        ]) {
          assert.ok(key in body, `report body must contain "${key}"`);
        }

        // Volume from the seeded mirror rows
        assert.equal(body.volume.created, 2, "2 tickets created in range");
        assert.equal(body.volume.closed, 1, "1 ticket closed in range");
        assert.equal(body.volume.openBacklog, 1, "1 open backlog ticket");
        assert.ok(Array.isArray(body.volume.trend), "volume.trend is an array");

        // TTR: single closed ticket, 5d - 1d = 4d
        assert.equal(body.timeToResolve.sampleCount, 1, "one TTR sample");
        assert.equal(
          body.timeToResolve.medianMs,
          4 * DAY,
          "median TTR is 4 days",
        );

        // Breakdowns: mapped dept + Unmapped bucket
        const deptNames = body.breakdowns.byDepartment.map((d: any) => d.name);
        assert.ok(deptNames.includes("Support"), "byDepartment includes Support");
        assert.ok(deptNames.includes("Unmapped"), "byDepartment includes Unmapped");
        const rtNames = body.breakdowns.byRequestType.map((d: any) => d.name);
        assert.ok(rtNames.includes("Bug Fix"), "byRequestType includes Bug Fix");

        // Aging: 5 buckets; the open 2d-old ticket falls in "1–3d"
        assert.equal(body.aging.length, 5, "5 aging buckets");
        const aging13 = body.aging.find((b: any) => b.label === "1–3d");
        assert.equal(aging13?.count, 1, "open ticket ages into 1–3d bucket");

        // Commitment: on-time close, one slip event, one overdue open ticket
        assert.equal(body.commitment.onTimePercent, 100, "on-time% is 100");
        assert.equal(body.commitment.slipCount, 1, "one slip event counted");
        assert.equal(body.commitment.overdueCount, 1, "one overdue open ticket");

        console.log("  ✓ C: team_lead gets 200 with correct report shape and numbers");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  // undici keep-alive sockets would otherwise hang exit under run-all.
  await getGlobalDispatcher().close();

  console.log("service-desk-reports-route: all sections passed (Task #3121).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("service-desk-reports-route: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
