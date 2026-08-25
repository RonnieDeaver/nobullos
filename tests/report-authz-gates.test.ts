/* test-registration
{
  "name": "CEO analytics + report delete route authz matrix (Task #4644)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the Task #4644 fix for a live-prod authz hole: the four CEO-analytics reads and DELETE /api/reports/:id were isAuthenticated-only, so any signed-in staff account could read CEO analytics or destructively delete reports. Fast isolated-schema route matrix (a couple dozen local HTTP requests, no external calls), deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #4644 — authorization matrix for the five endpoints the 2026-08-12
 * stability audit (§5.2, §10.1, §11) flagged as under-gated in production:
 *
 *   GET    /api/all-report-sections        → isAuthenticated + requireCeo
 *   GET    /api/ceo-pulses                 → isAuthenticated + requireCeo
 *   GET    /api/ceo-pulses/:id             → isAuthenticated + requireCeo
 *   GET    /api/ceo-pulses/month/:monthKey → isAuthenticated + requireCeo
 *   DELETE /api/reports/:id                → isAuthenticated + requireTeamLead
 *
 * Asserted per endpoint: anonymous → 401; roles below the gate → 403 with the
 * requireRole message and NO side effects; at/above the gate → the same
 * success behavior as before the gates landed. Actors are REAL seeded users
 * rows (sales / account_manager / team_lead / ceo) read back by
 * requireRole's storage.getUser() from the per-test isolated schema — no
 * legacy-role shortcut (reused-endpoint authz parity). The ladder under test
 * is ROLE_LEVELS (ceo:3 > team_lead:2 > account_manager:1; unknown roles like
 * legacy "sales" rank 0), so requireTeamLead admits team_lead AND ceo.
 *
 * Also pinned: the anonymous NoBull Brief share route
 * (GET /api/ceo-pulse/share/:token) stays reachable with NO session — the
 * Task #4644 gates must never leak onto the public share page.
 */

import "./helpers/forceTestEnv";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { registerReportRoutes } from "../server/routes/reports";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const RUN = Math.random().toString(36).slice(2, 8);
const TAG = `task-4644-${RUN}`;

const IDS = {
  sales: `${TAG}-sales`,
  account_manager: `${TAG}-am`,
  team_lead: `${TAG}-tl`,
  ceo: `${TAG}-ceo`,
} as const;

// Per-request actor. A string authenticates as that user id via the Clerk
// test seam (server/middlewares/requireAuth.ts); null = anonymous → 401.
let currentActor: string | null = null;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = currentActor;
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

async function request(
  baseUrl: string,
  method: string,
  p: string,
  actor: string | null,
): Promise<{ status: number; body: any }> {
  currentActor = actor;
  try {
    const r = await fetch(`${baseUrl}${p}`, { method });
    const text = await r.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed };
  } finally {
    currentActor = null;
  }
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.rows ?? []);

      // ── Seed real role rows (the matrix must exercise requireRole's actual
      // storage.getUser() read against these, not a shortcut) ──────────────
      for (const [role, id, authority] of [
        ["sales", IDS.sales, "core"],
        ["account_manager", IDS.account_manager, "core"],
        ["team_lead", IDS.team_lead, "lead"],
        ["ceo", IDS.ceo, "ceo"],
      ] as const) {
        await isoDb.execute(sql`
          INSERT INTO users (id, role, authority_level, first_name)
          VALUES (${id}, ${role}, ${authority}, ${`${TAG}-${role}`})
          ON CONFLICT (id) DO UPDATE
            SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
        `);
        // Admission fast-path only (requireAuth pre-reconciled registry);
        // role GATING still reads the seeded row via requireRole.
        __test_markUserReconciled(id, { id, role });
      }

      // ── Fixtures: one published pulse (share token), two reports with a
      // section each (delete success per admitted role). Months are
      // clock-derived PAST months (never future literals); reports get
      // distinct months because (client_id, report_month) is unique. ───────
      const monthKeyAgo = (monthsAgo: number): string => {
        const now = new Date();
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      };
      const MONTH = monthKeyAgo(1);
      const MONTH_B = monthKeyAgo(2);
      const SHARE_TOKEN = `${TAG}-share-token`;

      const pulseRes: any = await isoDb.execute(sql`
        INSERT INTO ceo_pulses (month_key, title, raw_content, include_graphs, created_by, is_published, share_token)
        VALUES (${MONTH}, ${`${TAG} pulse`}, ${"Authz matrix fixture content."}, true, ${IDS.ceo}, true, ${SHARE_TOKEN})
        RETURNING id
      `);
      const pulseId = String(rowsOf(pulseRes)[0].id);

      const clientRes: any = await isoDb.execute(sql`
        INSERT INTO clients (firm_name) VALUES (${`${TAG} firm`}) RETURNING id
      `);
      const clientId = String(rowsOf(clientRes)[0].id);

      const mkReport = async (month: string): Promise<string> => {
        const res: any = await isoDb.execute(sql`
          INSERT INTO reports (client_id, report_month, status, created_by)
          VALUES (${clientId}, ${month}, 'draft', ${IDS.ceo})
          RETURNING id
        `);
        const reportId = String(rowsOf(res)[0].id);
        await isoDb.execute(sql`
          INSERT INTO report_sections (report_id, section_key, data)
          VALUES (${reportId}, 'overview', ${JSON.stringify({ fixture: TAG })}::jsonb)
        `);
        return reportId;
      };
      const reportA = await mkReport(MONTH);
      const reportB = await mkReport(MONTH_B);

      const reportCount = async (id: string): Promise<number> => {
        const res: any = await isoDb.execute(
          sql`SELECT count(*)::int AS n FROM reports WHERE id = ${id}`,
        );
        return Number(rowsOf(res)[0]?.n ?? 0);
      };
      const sectionCount = async (reportId: string): Promise<number> => {
        const res: any = await isoDb.execute(
          sql`SELECT count(*)::int AS n FROM report_sections WHERE report_id = ${reportId}`,
        );
        return Number(rowsOf(res)[0]?.n ?? 0);
      };

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        // ── (1) The four CEO reads: 401 anon, 403 below-CEO, 200 CEO ──────
        const ceoReads = [
          "/api/all-report-sections",
          "/api/ceo-pulses",
          `/api/ceo-pulses/${pulseId}`,
          `/api/ceo-pulses/month/${MONTH}`,
        ];
        for (const p of ceoReads) {
          const anon = await request(baseUrl, "GET", p, null);
          assert.equal(anon.status, 401, `${p}: anonymous → 401`);

          for (const below of ["sales", "account_manager", "team_lead"] as const) {
            const r = await request(baseUrl, "GET", p, IDS[below]);
            assert.equal(r.status, 403, `${p}: ${below} → 403`);
            assert.equal(
              r.body?.error,
              "ceo access required",
              `${p}: ${below} → requireCeo message`,
            );
          }
        }
        console.log("  ok  (1) four CEO reads: anon 401, sales/am/team_lead 403");

        {
          // Task #4668 — the handler's section fan-out now reads via getDb()
          // (was the raw `db` import, which the sandbox cannot redirect), so
          // the seeded section/report linkage is visible and assertable: a
          // regression that silently empties this payload fails here.
          const r = await request(baseUrl, "GET", "/api/all-report-sections", IDS.ceo);
          assert.equal(r.status, 200, "all-report-sections: ceo → 200");
          assert.ok(Array.isArray(r.body), "all-report-sections: array body");
          for (const [reportId, month] of [
            [reportA, MONTH],
            [reportB, MONTH_B],
          ] as const) {
            const section = r.body.find(
              (s: any) => s.reportId === reportId && s.sectionKey === "overview",
            );
            assert.ok(section, `all-report-sections: seeded section for report ${reportId} present`);
            assert.equal(section.data?.fixture, TAG, "all-report-sections: seeded section data served");
            assert.equal(section.clientId, clientId, "all-report-sections: joined clientId");
            assert.equal(section.reportMonth, month, "all-report-sections: joined reportMonth");
            assert.equal(section.reportStatus, "draft", "all-report-sections: joined reportStatus");
          }
        }
        {
          const r = await request(baseUrl, "GET", "/api/ceo-pulses", IDS.ceo);
          assert.equal(r.status, 200, "ceo-pulses list: ceo → 200");
          assert.ok(
            Array.isArray(r.body) && r.body.some((p: any) => p.id === pulseId),
            "ceo-pulses list: seeded pulse present",
          );
        }
        {
          const r = await request(baseUrl, "GET", `/api/ceo-pulses/${pulseId}`, IDS.ceo);
          assert.equal(r.status, 200, "ceo-pulses/:id: ceo → 200");
          assert.equal(r.body?.id, pulseId, "ceo-pulses/:id: seeded pulse returned");
        }
        {
          const r = await request(baseUrl, "GET", `/api/ceo-pulses/month/${MONTH}`, IDS.ceo);
          assert.equal(r.status, 200, "ceo-pulses/month: ceo → 200");
          assert.equal(r.body?.monthKey, MONTH, "ceo-pulses/month: seeded month returned");
        }
        console.log("  ok  (2) four CEO reads succeed unchanged for the CEO");

        // ── (2) DELETE /api/reports/:id: 401 anon, 403 below team_lead with
        // no side effects, 204 for team_lead AND ceo ───────────────────────
        const del = (id: string, actor: string | null) =>
          request(baseUrl, "DELETE", `/api/reports/${id}`, actor);

        const anonDel = await del(reportA, null);
        assert.equal(anonDel.status, 401, "delete: anonymous → 401");

        for (const below of ["sales", "account_manager"] as const) {
          const r = await del(reportA, IDS[below]);
          assert.equal(r.status, 403, `delete: ${below} → 403`);
          assert.equal(
            r.body?.error,
            "team_lead access required",
            `delete: ${below} → requireTeamLead message`,
          );
        }
        assert.equal(await reportCount(reportA), 1, "denied deletes left the report intact");
        assert.equal(await sectionCount(reportA), 1, "denied deletes left its sections intact");

        const tlDel = await del(reportA, IDS.team_lead);
        assert.equal(tlDel.status, 204, "delete: team_lead → 204 (>=-level gate admits TL)");
        assert.equal(await reportCount(reportA), 0, "team_lead delete removed the report");
        assert.equal(await sectionCount(reportA), 0, "team_lead delete removed its sections");

        const ceoDel = await del(reportB, IDS.ceo);
        assert.equal(ceoDel.status, 204, "delete: ceo → 204 (above the gate)");
        assert.equal(await reportCount(reportB), 0, "ceo delete removed the report");

        const goneDel = await del(reportA, IDS.team_lead);
        assert.equal(goneDel.status, 404, "delete: missing id still 404s for an admitted role");
        console.log("  ok  (3) delete: anon 401, sales/am 403 side-effect-free, TL+CEO 204");

        // ── (3) The anonymous Brief share route is untouched by the gates ──
        const share = await request(baseUrl, "GET", `/api/ceo-pulse/share/${SHARE_TOKEN}`, null);
        assert.equal(share.status, 200, "share route: anonymous → 200 (no gate leak)");
        assert.equal(share.body?.monthKey, MONTH, "share route: published pulse payload");
        console.log("  ok  (4) anonymous share route still serves the published Brief");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      tables: ["users", "clients", "ceo_pulses", "reports", "report_sections"],
    },
  );
}

main().then(
  () => {
    console.log("report-authz-gates: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("report-authz-gates: FAILED");
    console.error(err);
    process.exit(1);
  },
);
