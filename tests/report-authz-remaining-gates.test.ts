/* test-registration
{
  "name": "Remaining report-route authz gates matrix (Task #4667 / #4750)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the Task #4667 authz sweep of server/routes/reports.ts (demo-report-setting pair, section-history requireCeo/requireTeamLead) and the Task #4750 decision that the legacy read-only sales role is now blocked from all report mutation routes via requireAccountManager, and (Task #4758) that the 5 report GET read routes stay open to sales. Fast isolated-schema route matrix (local HTTP requests, no external calls), deterministic under the hermetic per-run test DB.",
  "tier": "small"
}
test-registration */
/**
 * Task #4667 — authorization matrix for the routes the reports.ts sweep
 * moved from hand-rolled in-handler role checks onto the shared requireRole
 * middleware (mirroring Task #4644):
 *
 *   GET  /api/admin/demo-report-setting                  → isAuthenticated + requireCeo
 *   POST /api/admin/demo-report-setting                  → isAuthenticated + requireCeo
 *   GET  /api/reports/:id/sections/:sectionKey/history   → isAuthenticated + requireTeamLead
 *
 * Task #4750 — owner-confirmed product decision: the legacy read-only `sales`
 * role (rank 0 on the ROLE_LEVELS ladder) must be blocked from every report
 * mutation route, mirroring the requireTwilioAccess / requireCommandCenterAccess
 * convention. `requireAccountManager` was added to:
 *
 *   POST /api/reports                          → requireAccountManager
 *   PATCH /api/reports/:id                     → requireAccountManager
 *   POST /api/reports/:id/duplicate            → requireAccountManager
 *   PUT  /api/reports/:id/sections/:sectionKey → requireAccountManager
 *   POST /api/reports/:id/verdicts/draft       → requireAccountManager
 *   POST /api/reports/import-pdf               → requireAccountManager
 *   POST /api/reports/:id/reimport             → requireAccountManager
 *
 * Asserted per endpoint: anonymous → 401; roles below the gate → 403 with
 * the requireRole message and NO side effects; at/above the gate → success.
 * Actors are REAL seeded users rows read back by requireRole's
 * storage.getUser() from the per-test isolated schema — no legacy-role
 * shortcut. The legacy "admin" role the old hand-rolled checks admitted is
 * pinned to 403 (unknown roles rank 0 on the ROLE_LEVELS ladder).
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
const TAG = `task-4667-${RUN}`;

const IDS = {
  sales: `${TAG}-sales`,
  legacy_admin: `${TAG}-admin`,
  account_manager: `${TAG}-am`,
  team_lead: `${TAG}-tl`,
  ceo: `${TAG}-ceo`,
} as const;

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
  body?: unknown,
): Promise<{ status: number; body: any }> {
  currentActor = actor;
  try {
    const r = await fetch(`${baseUrl}${p}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
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

      // ── Seed real role rows (requireRole reads these via storage.getUser).
      // "admin" is the retired legacy role the old hand-rolled checks
      // admitted; it must now rank 0 and be denied.
      for (const [role, id, authority] of [
        ["sales", IDS.sales, "core"],
        ["admin", IDS.legacy_admin, "core"],
        ["account_manager", IDS.account_manager, "core"],
        ["team_lead", IDS.team_lead, "lead"],
        ["ceo", IDS.ceo, "ceo"],
      ] as const) {
        await isoDb.execute(sql`
          INSERT INTO users (id, role, authority_level, first_name, email)
          VALUES (${id}, ${role}, ${authority}, ${`${TAG}-${role}`}, ${`${id}@example.com`})
          ON CONFLICT (id) DO UPDATE
            SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
        `);
        __test_markUserReconciled(id, { id, role });
      }

      // ── Fixtures: one client + report + section (history rows via a raw
      // insert), plus a second report as the demo-setting target.
      const monthKeyAgo = (monthsAgo: number): string => {
        const now = new Date();
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      };
      const MONTH = monthKeyAgo(1);
      const MONTH_B = monthKeyAgo(2);

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
        return String(rowsOf(res)[0].id);
      };
      const reportA = await mkReport(MONTH);
      const demoTarget = await mkReport(MONTH_B);

      const sectionRes: any = await isoDb.execute(sql`
        INSERT INTO report_sections (report_id, section_key, data)
        VALUES (${reportA}, 'sales', ${JSON.stringify({ fixture: TAG })}::jsonb)
        RETURNING id
      `);
      const sectionId = String(rowsOf(sectionRes)[0].id);
      await isoDb.execute(sql`
        INSERT INTO report_section_history (
          report_section_id, report_id, section_key, previous_data, new_data,
          data_changed, edited_by, edit_source, created_at
        ) VALUES (
          ${sectionId}, ${reportA}, 'sales', NULL,
          ${JSON.stringify({ fixture: TAG })}::jsonb, true,
          ${`user:${IDS.ceo}`}, ${"ui_edit"}, now()
        )
      `);

      const demoSettingValue = async (): Promise<string | null> => {
        const res: any = await isoDb.execute(
          sql`SELECT value FROM system_settings WHERE key = 'demoReportId'`,
        );
        return rowsOf(res)[0]?.value ?? null;
      };

      const app = buildApp();
      const { server, baseUrl } = await listen(app);
      try {
        const HISTORY_PATH = `/api/reports/${reportA}/sections/sales/history`;
        const DEMO_PATH = "/api/admin/demo-report-setting";

        // ── (1) demo-report-setting GET/POST: 401 anon; sales/legacy-admin/
        // am/team_lead → 403 requireCeo message, no setting written ────────
        for (const [method, body] of [
          ["GET", undefined],
          ["POST", { reportId: demoTarget }],
        ] as const) {
          const anon = await request(baseUrl, method, DEMO_PATH, null, body);
          assert.equal(anon.status, 401, `${method} demo-setting: anonymous → 401`);
          for (const below of ["sales", "legacy_admin", "account_manager", "team_lead"] as const) {
            const r = await request(baseUrl, method, DEMO_PATH, IDS[below], body);
            assert.equal(r.status, 403, `${method} demo-setting: ${below} → 403`);
            assert.equal(r.body?.error, "ceo access required", `${method} demo-setting: ${below} → requireCeo message`);
          }
        }
        assert.equal(await demoSettingValue(), null, "denied POSTs wrote no demo setting");
        console.log("  ok  (1) demo-report-setting: anon 401, below-CEO 403 side-effect-free (legacy admin included)");

        // ── (2) demo-report-setting works for the CEO ──────────────────────
        {
          const empty = await request(baseUrl, "GET", DEMO_PATH, IDS.ceo);
          assert.equal(empty.status, 200, "GET demo-setting: ceo → 200");
          assert.equal(empty.body?.demoReportId, null, "GET demo-setting: null before set");

          const set = await request(baseUrl, "POST", DEMO_PATH, IDS.ceo, { reportId: demoTarget });
          assert.equal(set.status, 200, "POST demo-setting: ceo → 200");
          assert.equal(set.body?.demoReportId, demoTarget, "POST demo-setting: echoes target");
          assert.equal(await demoSettingValue(), demoTarget, "POST demo-setting: persisted");

          const read = await request(baseUrl, "GET", DEMO_PATH, IDS.ceo);
          assert.equal(read.body?.demoReportId, demoTarget, "GET demo-setting: reads back");

          const missing = await request(baseUrl, "POST", DEMO_PATH, IDS.ceo, { reportId: `${TAG}-nope` });
          assert.equal(missing.status, 404, "POST demo-setting: unknown report still 404s for CEO");
        }
        console.log("  ok  (2) demo-report-setting: CEO read/write path intact");

        // ── (3) section history: 401 anon; sales/legacy-admin/am 403; TL and
        // CEO get the enriched history rows ────────────────────────────────
        {
          const anon = await request(baseUrl, "GET", HISTORY_PATH, null);
          assert.equal(anon.status, 401, "history: anonymous → 401");
          for (const below of ["sales", "legacy_admin", "account_manager"] as const) {
            const r = await request(baseUrl, "GET", HISTORY_PATH, IDS[below]);
            assert.equal(r.status, 403, `history: ${below} → 403`);
            assert.equal(r.body?.error, "team_lead access required", `history: ${below} → requireTeamLead message`);
          }
          for (const admitted of ["team_lead", "ceo"] as const) {
            const r = await request(baseUrl, "GET", HISTORY_PATH, IDS[admitted]);
            assert.equal(r.status, 200, `history: ${admitted} → 200`);
            assert.ok(Array.isArray(r.body) && r.body.length === 1, `history: ${admitted} sees the seeded row`);
            assert.equal(r.body[0]?.editedBy, `user:${IDS.ceo}`, `history: ${admitted} row editedBy intact`);
            // editorUser hydration reads through the raw `db` import, which
            // the isolated-schema sandbox cannot redirect — pin shape only
            // (the key exists; unresolvable ids map to null). Full resolution
            // is pinned by tests/report-section-history-editor-user.test.ts.
            assert.ok("editorUser" in (r.body[0] ?? {}), `history: ${admitted} editorUser key present`);
          }
        }
        console.log("  ok  (3) section history: anon 401, below-TL 403 (legacy admin included), TL+CEO 200");

        // ── (4) requireAccountManager gates — Task #4750 ───────────────────
        // sales and legacy_admin must be blocked at the middleware level
        // (403 "account_manager access required") before any handler logic
        // runs. account_manager, team_lead, and ceo may pass the gate
        // (they will encounter other errors from missing input / no OpenAI,
        // but they must NOT get 403 from requireAccountManager).
        {
          // Endpoints that accept a JSON body (no file upload needed).
          const jsonMutations: Array<[string, string, unknown]> = [
            ["POST", "/api/reports", { clientId, reportMonth: MONTH, status: "draft" }],
            ["PATCH", `/api/reports/${reportA}`, { status: "draft" }],
            ["POST", `/api/reports/${reportA}/duplicate`, { targetMonth: monthKeyAgo(3) }],
            ["PUT", `/api/reports/${reportA}/sections/sales`, { data: { fixture: TAG } }],
            ["POST", `/api/reports/${reportA}/verdicts/draft`, { slideKey: "intake" }],
          ];

          for (const [method, path, body] of jsonMutations) {
            const anon = await request(baseUrl, method, path, null, body);
            assert.equal(anon.status, 401, `${method} ${path}: anonymous → 401`);

            for (const blocked of ["sales", "legacy_admin"] as const) {
              const r = await request(baseUrl, method, path, IDS[blocked], body);
              assert.equal(r.status, 403, `${method} ${path}: ${blocked} → 403`);
              assert.equal(
                r.body?.error,
                "account_manager access required",
                `${method} ${path}: ${blocked} → requireAccountManager message`,
              );
            }

            // account_manager, team_lead, and ceo must pass the gate.
            for (const admitted of ["account_manager", "team_lead", "ceo"] as const) {
              const r = await request(baseUrl, method, path, IDS[admitted], body);
              assert.notEqual(
                r.status,
                403,
                `${method} ${path}: ${admitted} must not be blocked by requireAccountManager (got ${r.status} — ${JSON.stringify(r.body)})`,
              );
            }
          }

          // File-upload endpoints: send without a file; the gate runs before
          // multer's single() handler, so we still get 403 for blocked roles
          // and something other than 403 for admitted roles (typically 400 /
          // 422 for "No PDF file uploaded" or similar).
          const uploadMutations: Array<[string, string]> = [
            ["POST", "/api/reports/import-pdf"],
            ["POST", `/api/reports/${reportA}/reimport`],
          ];

          for (const [method, path] of uploadMutations) {
            const anon = await request(baseUrl, method, path, null);
            assert.equal(anon.status, 401, `${method} ${path}: anonymous → 401`);

            for (const blocked of ["sales", "legacy_admin"] as const) {
              const r = await request(baseUrl, method, path, IDS[blocked]);
              assert.equal(r.status, 403, `${method} ${path}: ${blocked} → 403`);
              assert.equal(
                r.body?.error,
                "account_manager access required",
                `${method} ${path}: ${blocked} → requireAccountManager message`,
              );
            }

            for (const admitted of ["account_manager", "team_lead", "ceo"] as const) {
              const r = await request(baseUrl, method, path, IDS[admitted]);
              assert.notEqual(
                r.status,
                403,
                `${method} ${path}: ${admitted} must not be blocked by requireAccountManager (got ${r.status})`,
              );
            }
          }
        }
        console.log("  ok  (4) report mutation gates: anon 401, sales/legacy-admin 403, AM+ passes gate (Task #4750)");

        // ── (5) read routes stay OPEN to sales — Task #4758 ───────────────
        // Task #4750's owner-confirmed decision explicitly kept the report
        // read routes at bare isAuthenticated: sales retains read access.
        // Pin that here so an accidental requireAccountManager (or higher)
        // on a GET route fails this suite instead of silently breaking the
        // sales UI. Asserted: sales → 2xx (not merely "not 403").
        {
          const readRoutes: Array<[string, string]> = [
            ["read: reports list", "/api/reports"],
            ["read: reports matrix", "/api/reports/matrix"],
            ["read: report by id", `/api/reports/${reportA}`],
            ["read: report sections", `/api/reports/${reportA}/sections`],
            ["read: report preview", `/api/preview/${reportA}`],
          ];
          for (const [label, path] of readRoutes) {
            const anon = await request(baseUrl, "GET", path, null);
            assert.equal(anon.status, 401, `${label}: anonymous → 401 (still authenticated-only)`);

            const r = await request(baseUrl, "GET", path, IDS.sales);
            assert.ok(
              r.status >= 200 && r.status < 300,
              `${label}: sales must get 2xx (got ${r.status} — ${JSON.stringify(r.body).slice(0, 300)})`,
            );
          }
        }
        console.log("  ok  (5) read routes: sales reaches all 5 GET routes with 2xx (Task #4758)");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    {
      tables: ["users", "clients", "reports", "report_sections", "report_section_history", "system_settings"],
    },
  );
}

main().then(
  () => {
    console.log("report-authz-remaining-gates: all sections passed");
    process.exit(0);
  },
  (err) => {
    console.error("report-authz-remaining-gates: FAILED");
    console.error(err);
    process.exit(1);
  },
);
