/* test-registration
{
  "name": "Service Desk department membership — memberCount listing, people-picker add with ClickUp auto-resolve, team-lead console add/remove (Task #4002)",
  "regression": true,
  "sweepOnlyReason": "Task #4002 — department membership endpoints: DB-heavy (runInIsolatedSchema: users, clients, clickup_user_tokens, sd_* tables) + real HTTP server; source contracts are smoke-gated in sd-membership-management-smoke instead.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4002 — membership management backend:
 *
 *   GET    /api/service-desk/departments                       (memberCount)
 *   POST   /api/service-desk/departments/:id/members           (auto-resolve ClickUp)
 *   PUT    /api/service-desk/departments/:id/members/:memberId (team-lead gate)
 *   DELETE /api/service-desk/departments/:id/members/:memberId (console remove)
 *
 * Sections:
 *   (A) Departments listing carries active-only memberCount per department
 *   (B) Member add gates: unauthenticated → 401; account_manager → 403;
 *       exact team_lead → 200 (console membership management; was CEO-only)
 *   (C) Auto-resolve: no manual ClickUp id + CONNECTED clickup_user_tokens row
 *       → member stored with the token's ClickUp id, clickupResolution "connected"
 *   (D) Manual override wins over a connected token → "manual"
 *   (E) No override + only a REVOKED token → ClickUp id null, "none"
 *       (status filter: revoked tokens must not resolve)
 *   (F) Reactivation preserves a previously stored ClickUp id when nothing new
 *       is known (deactivate via PUT, re-add without override → id kept)
 *   (G) memberCount reflects membership changes
 *   (H) Team-lead DELETE removes the member; coverage membersByDept drops the
 *       user (data layer behind "role pickers update immediately")
 *
 * Runs with pinGetDbForCrossAsync so Express handlers read the cloned tables.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { registerServiceDeskRoutes } from "../server/routes/serviceDesk";
import { sdDepartments, sdDepartmentMembers } from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import { encryptToken } from "../server/utils/tokenCrypto";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const RUN = Math.random().toString(36).slice(2, 8);
const LEAD_ID = `test-4002-lead-${RUN}`;
const AM_ID = `test-4002-am-${RUN}`;
const SEEDED_MEMBER_ID = `test-4002-seeded-${RUN}`;
const INACTIVE_MEMBER_ID = `test-4002-inactive-${RUN}`;
const CONNECTED_ID = `test-4002-connected-${RUN}`;
const MANUAL_ID = `test-4002-manual-${RUN}`;
const NONE_ID = `test-4002-none-${RUN}`;
const KEEP_ID = `test-4002-keep-${RUN}`;
const CLIENT_A = `test-4002-client-a-${RUN}`;
const DEPT_SEEDED = `dept-4002-a-${RUN}`;
const DEPT_TARGET = `dept-4002-b-${RUN}`;

const CU_CONNECTED = `cu-conn-${RUN}`;
const CU_OTHER = `cu-conn-other-${RUN}`;
const CU_MANUAL = `cu-manual-${RUN}`;
const CU_REVOKED = `cu-revoked-${RUN}`;
const CU_KEEP = `cu-keep-${RUN}`;
const WORKSPACE_ID = `workspace-4002-${RUN}`;

const TABLES = [
  "users",
  "clients",
  "clickup_user_tokens",
  "sd_list_mapping",
  "sd_departments",
  "sd_department_members",
  "sd_client_dept_assignments",
] as const;

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

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function req(
  baseUrl: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: payload !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

function membersPath(deptId: string): string {
  return `/api/service-desk/departments/${deptId}/members`;
}

async function getMemberCounts(baseUrl: string): Promise<Map<string, number>> {
  const resp = await req(baseUrl, "GET", "/api/service-desk/departments");
  assert.equal(resp.status, 200, `GET departments must be 200 (got ${resp.status})`);
  const departments = resp.body?.departments as any[];
  assert.ok(Array.isArray(departments), "GET departments must return { departments: [...] }");
  return new Map(departments.map((d) => [d.id, d.memberCount]));
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed ───────────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES
          (${LEAD_ID}, 'team_lead', 'Lead 4002'),
          (${AM_ID}, 'account_manager', 'AM 4002'),
          (${SEEDED_MEMBER_ID}, 'account_manager', 'Seeded 4002'),
          (${INACTIVE_MEMBER_ID}, 'account_manager', 'Inactive 4002'),
          (${CONNECTED_ID}, 'account_manager', 'Connected 4002'),
          (${MANUAL_ID}, 'account_manager', 'Manual 4002'),
          (${NONE_ID}, 'account_manager', 'None 4002'),
          (${KEEP_ID}, 'account_manager', 'Keep 4002')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Pre-register the acting users so requireAuth resolves them from the
      // sandbox seed instead of JIT-provisioning a public-schema row.
      __test_markUserReconciled(LEAD_ID, { id: LEAD_ID, role: "team_lead", firstName: "Lead 4002" });
      __test_markUserReconciled(AM_ID, { id: AM_ID, role: "account_manager", firstName: "AM 4002" });

      await db.execute(sql`
        INSERT INTO clients (id, firm_name, is_archived)
        VALUES (${CLIENT_A}, 'Firm A 4002', false)
        ON CONFLICT (id) DO UPDATE SET firm_name = EXCLUDED.firm_name
      `);
      await db.execute(sql`
        INSERT INTO sd_list_mapping (id, clickup_workspace_id)
        VALUES (${`mapping-4002-${RUN}`}, ${WORKSPACE_ID})
      `);
      // ClickUp identities: CONNECTED has a live token; MANUAL also has one
      // (proves the override outranks it); NONE only has a REVOKED token
      // (proves the status filter); KEEP has none at all. The acting lead's
      // real encrypted test token verifies manual IDs against the workspace.
      await db.execute(sql`
        INSERT INTO clickup_user_tokens
          (user_id, access_token_encrypted, clickup_user_id, workspace_id, authorized_workspaces, status)
        VALUES
          (${LEAD_ID}, ${encryptToken("lead-4002-token")}, ${`cu-lead-${RUN}`}, ${WORKSPACE_ID}, ${JSON.stringify([{ id: WORKSPACE_ID, name: "Test Workspace" }])}::jsonb, 'connected'),
          (${CONNECTED_ID}, 'test-cipher', ${CU_CONNECTED}, ${WORKSPACE_ID}, ${JSON.stringify([{ id: WORKSPACE_ID, name: "Test Workspace" }])}::jsonb, 'connected'),
          (${MANUAL_ID}, 'test-cipher', ${CU_OTHER}, ${WORKSPACE_ID}, ${JSON.stringify([{ id: WORKSPACE_ID, name: "Test Workspace" }])}::jsonb, 'connected'),
          (${NONE_ID}, 'test-cipher', ${CU_REVOKED}, ${WORKSPACE_ID}, ${JSON.stringify([{ id: WORKSPACE_ID, name: "Test Workspace" }])}::jsonb, 'revoked')
      `);
      await db.insert(sdDepartments).values([
        { id: DEPT_SEEDED, name: `Bookkeeping 4002 ${RUN}`, active: true, sortOrder: 1 },
        { id: DEPT_TARGET, name: `Payroll 4002 ${RUN}`, active: true, sortOrder: 2 },
      ]).onConflictDoNothing();
      // DEPT_SEEDED: one active + one INACTIVE membership (count must be
      // active-only). DEPT_TARGET starts empty.
      await db.insert(sdDepartmentMembers).values([
        { departmentId: DEPT_SEEDED, userId: SEEDED_MEMBER_ID, active: true },
        { departmentId: DEPT_SEEDED, userId: INACTIVE_MEMBER_ID, active: false },
      ]).onConflictDoNothing();

      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === `/api/v2/team/${WORKSPACE_ID}`) {
          return new Response(
            JSON.stringify({
              team: {
                members: [
                  { user: { id: CU_MANUAL } },
                  { user: { id: CU_KEEP } },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return nativeFetch(input as any, init);
      }) as typeof fetch;

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (A) memberCount in the departments listing ────────────────────
        activeUserId = LEAD_ID;
        const counts0 = await getMemberCounts(baseUrl);
        assert.equal(
          counts0.get(DEPT_SEEDED),
          1,
          `A: seeded dept must count only ACTIVE members (expected 1, got ${counts0.get(DEPT_SEEDED)})`,
        );
        assert.equal(
          counts0.get(DEPT_TARGET),
          0,
          `A: empty dept must report memberCount 0 (got ${counts0.get(DEPT_TARGET)})`,
        );
        console.log("  ✓ A: departments listing carries active-only memberCount");

        // ── (B) member-add gates ──────────────────────────────────────────
        activeUserId = null;
        const anon = await req(baseUrl, "POST", membersPath(DEPT_TARGET), { userId: CONNECTED_ID });
        assert.equal(anon.status, 401, `B: unauthenticated add must be 401 (got ${anon.status})`);

        activeUserId = AM_ID;
        const am = await req(baseUrl, "POST", membersPath(DEPT_TARGET), { userId: CONNECTED_ID });
        assert.equal(am.status, 403, `B: account_manager add must be 403 (got ${am.status})`);

        // Exact team_lead actor (no CEO shortcut) — the Role Assignments
        // console audience. Also doubles as section C's add.
        activeUserId = LEAD_ID;
        const leadAdd = await req(baseUrl, "POST", membersPath(DEPT_TARGET), { userId: CONNECTED_ID });
        assert.equal(leadAdd.status, 200, `B: team_lead add must be 200 (got ${leadAdd.status}: ${JSON.stringify(leadAdd.body)})`);
        console.log("  ✓ B: member add is team-lead-gated (401 anon, 403 AM, 200 team_lead)");

        // ── (C) ClickUp auto-resolve from connected token ─────────────────
        assert.equal(leadAdd.body?.clickupResolution, "connected", "C: resolution must be 'connected'");
        assert.equal(
          leadAdd.body?.member?.clickupUserId,
          CU_CONNECTED,
          `C: member must carry the token's ClickUp id (got ${leadAdd.body?.member?.clickupUserId})`,
        );
        assert.equal(leadAdd.body?.member?.active, true, "C: added member must be active");
        const connectedMemberId = leadAdd.body.member.id as string;

        // ── (D) manual override wins over a connected token ───────────────
        const manualAdd = await req(baseUrl, "POST", membersPath(DEPT_TARGET), {
          userId: MANUAL_ID,
          clickupUserId: CU_MANUAL,
        });
        assert.equal(manualAdd.status, 200, `D: add must be 200 (got ${manualAdd.status})`);
        assert.equal(manualAdd.body?.clickupResolution, "manual", "D: resolution must be 'manual'");
        assert.equal(
          manualAdd.body?.member?.clickupUserId,
          CU_MANUAL,
          `D: manual override must win over the connected token (got ${manualAdd.body?.member?.clickupUserId})`,
        );
        console.log("  ✓ C/D: ClickUp id auto-resolves from connected token; manual override wins");

        // ── (E) revoked token does not resolve ────────────────────────────
        const noneAdd = await req(baseUrl, "POST", membersPath(DEPT_TARGET), { userId: NONE_ID });
        assert.equal(noneAdd.status, 200, `E: add must be 200 (got ${noneAdd.status})`);
        assert.equal(noneAdd.body?.clickupResolution, "none", "E: resolution must be 'none'");
        assert.equal(
          noneAdd.body?.member?.clickupUserId,
          null,
          `E: revoked token must not resolve (got ${noneAdd.body?.member?.clickupUserId})`,
        );
        console.log("  ✓ E: revoked ClickUp token does not auto-resolve (id null, resolution 'none')");

        // ── (F) reactivation preserves a stored ClickUp id ────────────────
        const keepAdd = await req(baseUrl, "POST", membersPath(DEPT_TARGET), {
          userId: KEEP_ID,
          clickupUserId: CU_KEEP,
        });
        assert.equal(keepAdd.status, 200, `F: initial add must be 200 (got ${keepAdd.status})`);
        const keepMemberId = keepAdd.body.member.id as string;

        // Deactivate via PUT as team_lead (gate also widened from CEO-only).
        const deact = await req(baseUrl, "PUT", `${membersPath(DEPT_TARGET)}/${keepMemberId}`, { active: false });
        assert.equal(deact.status, 200, `F: team_lead PUT must be 200 (got ${deact.status})`);
        assert.equal(deact.body?.member?.active, false, "F: member must be deactivated");

        // Re-add with no override and no token: id must be preserved, not wiped.
        const readd = await req(baseUrl, "POST", membersPath(DEPT_TARGET), { userId: KEEP_ID });
        assert.equal(readd.status, 200, `F: re-add must be 200 (got ${readd.status})`);
        assert.equal(readd.body?.member?.active, true, "F: re-add must reactivate the membership");
        assert.equal(readd.body?.clickupResolution, "none", "F: nothing new resolved on re-add");
        assert.equal(
          readd.body?.member?.clickupUserId,
          CU_KEEP,
          `F: reactivation must preserve the stored ClickUp id (got ${readd.body?.member?.clickupUserId})`,
        );
        console.log("  ✓ F: reactivating a member preserves the previously stored ClickUp id");

        // ── (G) memberCount reflects membership changes ───────────────────
        const counts1 = await getMemberCounts(baseUrl);
        assert.equal(
          counts1.get(DEPT_TARGET),
          4,
          `G: target dept must now count 4 active members (got ${counts1.get(DEPT_TARGET)})`,
        );
        console.log("  ✓ G: memberCount tracks adds/reactivations");

        // ── (H) team-lead remove + coverage reflection ────────────────────
        const covBefore = await req(baseUrl, "GET", "/api/service-desk/coverage");
        assert.equal(covBefore.status, 200, "H: coverage must be 200");
        assert.ok(
          (covBefore.body?.membersByDept?.[DEPT_TARGET] ?? []).includes(CONNECTED_ID),
          "H: coverage membersByDept must include the added member before removal",
        );

        const del = await req(baseUrl, "DELETE", `${membersPath(DEPT_TARGET)}/${connectedMemberId}`);
        assert.equal(del.status, 200, `H: team_lead DELETE must be 200 (got ${del.status})`);
        assert.equal(del.body?.success, true, "H: DELETE must report success");

        const covAfter = await req(baseUrl, "GET", "/api/service-desk/coverage");
        assert.equal(covAfter.status, 200, "H: coverage after removal must be 200");
        const targetMembers = covAfter.body?.membersByDept?.[DEPT_TARGET] ?? [];
        assert.ok(
          !targetMembers.includes(CONNECTED_ID),
          `H: removed member must vanish from coverage membersByDept (got ${JSON.stringify(targetMembers)})`,
        );
        assert.ok(
          targetMembers.includes(MANUAL_ID) && targetMembers.includes(NONE_ID) && targetMembers.includes(KEEP_ID),
          `H: remaining members must stay in coverage membersByDept (got ${JSON.stringify(targetMembers)})`,
        );

        const counts2 = await getMemberCounts(baseUrl);
        assert.equal(
          counts2.get(DEPT_TARGET),
          3,
          `H: memberCount must drop after removal (expected 3, got ${counts2.get(DEPT_TARGET)})`,
        );
        console.log("  ✓ H: team_lead remove works and coverage/membersByDept + counts reflect it");
      } finally {
        globalThis.fetch = nativeFetch;
        server.close();
        __test_resetReconciledUsers();
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  await getGlobalDispatcher().close();

  console.log("sd-department-members-route: all sections passed (Task #4002).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("sd-department-members-route: FAILED —", err?.stack ?? err, err?.cause ?? "");
    process.exit(1);
  },
);
