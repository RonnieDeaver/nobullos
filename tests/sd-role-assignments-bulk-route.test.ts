/* test-registration
{
  "name": "Universal Role Assignments API — Doer/Checker bulk state and coverage",
  "regression": true,
  "sweepOnlyReason": "Task #3626 — Role Assignments bulk endpoint: DB-heavy (runInIsolatedSchema: users, clients, sd_* tables, admin_setting_audit) + real HTTP server; not a smoke-gate candidate.",
  "extraEnv": {
    "NODE_ENV": "test",
    "CLICKUP_ROLE_PROJECTION_ENVIRONMENT": "sandbox"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3626 — Role Assignments console backend:
 *
 *   POST /api/admin/role-assignments/bulk
 *   GET  /api/admin/role-assignments
 *
 * Sections:
 *   (A) Auth gates: unauthenticated → 401; account_manager → 403
 *   (B) Validation: missing departmentId / bad role / empty clientIds → 400;
 *       unknown dept → 404
 *   (C) Supported-role non-member userId → 422
 *   (D) Unknown/archived client in batch → 400, nothing written (all-or-nothing)
 *   (E) Successful bulk apply: fills a gap + overwrites an existing holder,
 *       only the target role column is touched, changes payload correct,
 *       audit row recorded in admin_setting_audit with actor + change set
 *   (F) Bulk clear (userId null) empties the role slot
 *   (G) Coverage grid emits Doer/Checker gap and stale fields
 *   (H) Task #4171 — company-scope dept: bulk → 422 (no writes); coverage
 *       moves the dept out of rows into companyRows with per-role
 *       stale/missing computed against active membership
 *   (I) Task #4171 — per-role default fallback in coverage: an active dept
 *       default covers an empty slot; a stale default does not; an assigned
 *       (even stale) person blocks the default fallback
 *
 * Runs with pinGetDbForCrossAsync so Express handlers read the cloned tables.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { registerServiceDeskRoutes } from "../server/routes/serviceDesk";
import { sdDepartments, sdDepartmentMembers } from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import {
  GBP_LOCAL_SEO_DEPARTMENT_ID,
  PAID_SEARCH_DEPARTMENT_ID,
} from "../shared/departmentRoleCapabilities";

const RUN = Math.random().toString(36).slice(2, 8);
const LEAD_ID = `test-3626-lead-${RUN}`;
const CEO_ID = `test-3626-ceo-${RUN}`;
const AM_ID = `test-3626-am-${RUN}`;
const MEMBER_ID = `test-3626-member-${RUN}`;
const MEMBER2_ID = `test-3626-member2-${RUN}`;
const CLIENT_A = randomUUID();
const CLIENT_B = `test-3626-client-b-${RUN}`;
const CLIENT_ARCHIVED = `test-3626-client-arch-${RUN}`;
// The primary test department is an owner-approved Checker-capable UUID.
const DEPT_ID = PAID_SEARCH_DEPARTMENT_ID;
const GBP_DEPT_ID = GBP_LOCAL_SEO_DEPARTMENT_ID;
// Newly-created / unknown IDs must default to Doer-only.
const DEFAULT_DENY_DEPT_ID = randomUUID();
const INACTIVE_DEPT_ID = `dept-3626-inactive-${RUN}`;
const PROJECTION_DEST_ID = `dest-3626-${RUN}`;

const TABLES = [
  "users",
  "clients",
  "sd_list_mapping",
  "sd_departments",
  "sd_department_members",
  "sd_client_dept_assignments",
  "admin_setting_audit",
  "cu_role_projection_destinations",
  "cu_role_projection_client_targets",
  "cu_role_projection_commands",
  "work_queue",
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

const BULK_PATH = "/api/admin/role-assignments/bulk";
const COVERAGE_PATH = "/api/admin/role-assignments";

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed ───────────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES
          (${LEAD_ID}, 'team_lead', 'Lead 3626'),
          (${CEO_ID}, 'ceo', 'CEO 3626'),
          (${AM_ID}, 'account_manager', 'AM 3626'),
          (${MEMBER_ID}, 'account_manager', 'Member 3626'),
          (${MEMBER2_ID}, 'account_manager', 'Member2 3626')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Pre-register the acting users so requireAuth resolves them from the
      // sandbox seed instead of JIT-provisioning a public-schema row.
      __test_markUserReconciled(LEAD_ID, { id: LEAD_ID, role: "team_lead", firstName: "Lead 3626" });
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 3626" });
      __test_markUserReconciled(AM_ID, { id: AM_ID, role: "account_manager", firstName: "AM 3626" });

      await db.execute(sql`
        INSERT INTO clients (id, firm_name, is_archived)
        VALUES
          (${CLIENT_A}, 'Firm A 3626', false),
          (${CLIENT_B}, 'Firm B 3626', false),
          (${CLIENT_ARCHIVED}, 'Firm Archived 3626', true)
        ON CONFLICT (id) DO UPDATE SET firm_name = EXCLUDED.firm_name
      `);
      await db.insert(sdDepartments).values({
        id: DEPT_ID,
        name: `Support 3626 ${RUN}`,
        active: true,
        sortOrder: 1,
      }).onConflictDoNothing();
      await db.insert(sdDepartments).values([
        {
          id: GBP_DEPT_ID,
          name: `GBP Local SEO 3626 ${RUN}`,
          active: true,
          sortOrder: 2,
        },
        {
          id: DEFAULT_DENY_DEPT_ID,
          name: `New Default-Deny 3626 ${RUN}`,
          active: true,
          sortOrder: 3,
        },
      ]).onConflictDoNothing();
      await db.insert(sdDepartments).values({
        id: INACTIVE_DEPT_ID,
        name: `Inactive 3626 ${RUN}`,
        active: false,
        sortOrder: 2,
      }).onConflictDoNothing();
      await db.insert(sdDepartmentMembers).values([
        { departmentId: DEPT_ID, userId: MEMBER_ID, active: true },
        { departmentId: DEPT_ID, userId: MEMBER2_ID, active: true },
          { departmentId: GBP_DEPT_ID, userId: MEMBER_ID, active: true },
          { departmentId: DEFAULT_DENY_DEPT_ID, userId: MEMBER_ID, active: true },
        { departmentId: INACTIVE_DEPT_ID, userId: MEMBER2_ID, active: true },
      ]).onConflictDoNothing();

      // Pre-existing assignment on CLIENT_B: MEMBER2 is checker (will be
      // overwritten in E) and MEMBER2 is primary (must be untouched by a
      // checker-role bulk change).
      await db.execute(sql`
        INSERT INTO sd_client_dept_assignments (client_id, department_id, primary_user_id, checker_user_id)
        VALUES (${CLIENT_B}, ${DEPT_ID}, ${MEMBER2_ID}, ${MEMBER2_ID})
      `);

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      const countAssignments = async () => {
        const r = await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM sd_client_dept_assignments WHERE department_id = ${DEPT_ID}
        `);
        return (r as any).rows[0].n as number;
      };

      try {
        // ── (A) auth gates ────────────────────────────────────────────────
        activeUserId = null;
        const anon = await req(baseUrl, "POST", BULK_PATH, {});
        assert.equal(anon.status, 401, `unauthenticated bulk must be 401 (got ${anon.status})`);

        activeUserId = AM_ID;
        const am = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID, responsibility: "checker", userId: MEMBER_ID, clientIds: [CLIENT_A],
        });
        assert.equal(am.status, 403, `account_manager bulk must be 403 (got ${am.status})`);
        activeUserId = LEAD_ID;
        console.log("  ✓ A: bulk endpoint auth gates (401 / 403)");

        // ── (B) validation ────────────────────────────────────────────────
        const noDept = await req(baseUrl, "POST", BULK_PATH, { responsibility: "checker", clientIds: [CLIENT_A] });
        assert.equal(noDept.status, 400, "missing departmentId must be 400");

        const badRole = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID, responsibility: "owner", clientIds: [CLIENT_A],
        });
        assert.equal(badRole.status, 400, "invalid role must be 400");

        const emptyClients = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID, responsibility: "checker", userId: MEMBER_ID, clientIds: [],
        });
        assert.equal(emptyClients.status, 400, "empty clientIds must be 400");

        const unknownField = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID,
          responsibility: "checker",
          userId: MEMBER_ID,
          clientIds: [CLIENT_A],
          unexpectedProjectionOverride: true,
        });
        assert.equal(unknownField.status, 400, "unknown bulk mutation fields must be 400");

        const unknownDept = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: `nope-${RUN}`, responsibility: "checker", userId: MEMBER_ID, clientIds: [CLIENT_A],
        });
        assert.equal(unknownDept.status, 404, "unknown department must be 404");

        // Task #5233: both explicitly approved UUIDs may write Checker, while
        // a newly-created department is default-deny (but remains Doer-capable).
        const secondApprovedChecker = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: GBP_DEPT_ID, responsibility: "checker", userId: MEMBER_ID, clientIds: [CLIENT_A],
        });
        assert.equal(
          secondApprovedChecker.status,
          200,
          `GBP / Local SEO approved UUID must accept Checker writes (got ${secondApprovedChecker.status}: ${JSON.stringify(secondApprovedChecker.body)})`,
        );
        const deniedChecker = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEFAULT_DENY_DEPT_ID, responsibility: "checker", userId: MEMBER_ID, clientIds: [CLIENT_A],
        });
        assert.equal(
          deniedChecker.status,
          422,
          `new/unapproved department must reject Checker writes (got ${deniedChecker.status}: ${JSON.stringify(deniedChecker.body)})`,
        );
        assert.match(
          String(deniedChecker.body?.error ?? ""),
          /checker.*support|support.*checker/i,
          "unsupported Checker rejection must explain the department capability",
        );
        const allowedDoer = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEFAULT_DENY_DEPT_ID, responsibility: "doer", userId: MEMBER_ID, clientIds: [CLIENT_A],
        });
        assert.equal(allowedDoer.status, 200, "default-deny department must retain its Doer slot");
        const defaultDenyRead = await req(
          baseUrl,
          "GET",
          `/api/admin/role-assignments/clients/${CLIENT_A}`,
        );
        assert.equal(defaultDenyRead.status, 200, "default-deny client assignment read must succeed");
        const defaultDenyAssignment = (defaultDenyRead.body.assignments as any[]).find(
          (assignment) => assignment.departmentId === DEFAULT_DENY_DEPT_ID,
        );
        const defaultDenyDepartment = (defaultDenyRead.body.departments as any[]).find(
          (department) => department.id === DEFAULT_DENY_DEPT_ID,
        );
        const defaultDenyResolved = (defaultDenyRead.body.resolvedAssignments as any[]).find(
          (assignment) => assignment.departmentId === DEFAULT_DENY_DEPT_ID,
        );
        assert.ok(defaultDenyAssignment, "default-deny assignment read includes its Doer state");
        assert.ok(defaultDenyDepartment, "default-deny department read includes capability metadata");
        assert.ok(defaultDenyResolved, "default-deny resolver read includes supported role states");
        assert.equal(
          Object.prototype.hasOwnProperty.call(defaultDenyAssignment, "checkerUserId"),
          false,
          "Doer-only assignment reads omit checkerUserId instead of synthesizing null",
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(defaultDenyDepartment, "defaultCheckerUserId"),
          false,
          "Doer-only department reads omit defaultCheckerUserId instead of synthesizing null",
        );
        assert.deepEqual(
          defaultDenyDepartment.roleCapabilities,
          { doer: true, checker: false },
          "Doer-only department reads expose the default-deny capability contract",
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(defaultDenyResolved.roles, "checker"),
          false,
          "Doer-only resolver reads omit the unsupported Checker role state",
        );
        const clientTeamOptions = await req(
          baseUrl,
          "GET",
          "/api/service-desk/client-team-options",
        );
        assert.equal(clientTeamOptions.status, 200, "client creation team options must succeed");
        const defaultDenyTeamOption = (clientTeamOptions.body.departments as any[]).find(
          (department) => department.id === DEFAULT_DENY_DEPT_ID,
        );
        assert.ok(defaultDenyTeamOption, "client creation includes the Doer-only department");
        assert.equal(
          Object.prototype.hasOwnProperty.call(defaultDenyTeamOption, "defaultCheckerUserId"),
          false,
          "client creation reads omit the unsupported defaultCheckerUserId slot",
        );
        const deniedRows = await db.execute(sql`
          SELECT primary_user_id, checker_user_id
          FROM sd_client_dept_assignments
          WHERE client_id = ${CLIENT_A} AND department_id = ${DEFAULT_DENY_DEPT_ID}
        `);
        assert.deepEqual(
          (deniedRows as any).rows[0],
          { primary_user_id: MEMBER_ID, checker_user_id: null },
          "rejected Checker write must not persist a Checker holder",
        );
        activeUserId = CEO_ID;
        const deniedDestination = await req(
          baseUrl,
          "PUT",
          "/api/service-desk/role-projections/destinations",
          {
            departmentId: DEFAULT_DENY_DEPT_ID,
            responsibility: "checker",
            environment: "sandbox",
            workspaceId: "workspace-3626",
            listId: "sandbox-list-3626",
            targetId: "task-3626",
            targetKind: "direct_task",
            peopleFieldId: "people-3626",
            enabled: false,
          },
        );
        assert.equal(
          deniedDestination.status,
          400,
          `projection destination must reject unsupported Checker (got ${deniedDestination.status}: ${JSON.stringify(deniedDestination.body)})`,
        );
        assert.match(
          JSON.stringify(deniedDestination.body),
          /checker.*support|support.*checker/i,
          "projection destination rejection must identify the unsupported Checker capability",
        );
        const destinationRows = await db.execute(sql`
          SELECT COUNT(*)::int AS n
          FROM cu_role_projection_destinations
          WHERE department_id = ${DEFAULT_DENY_DEPT_ID} AND responsibility = 'checker'
        `);
        assert.equal(
          (destinationRows as any).rows[0].n,
          0,
          "rejected unsupported Checker destination must not be persisted",
        );
        activeUserId = LEAD_ID;
        console.log("  ✓ B: bulk validation + approved Checker UUIDs + default-deny Checker rejection");

        // ── (C) membership eligibility ───────────────────────────────────
        const before = await countAssignments();
        const nonMember = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID, responsibility: "checker", userId: AM_ID, clientIds: [CLIENT_A, CLIENT_B],
        });
        assert.equal(nonMember.status, 422, `non-member userId must be 422 (got ${nonMember.status}: ${JSON.stringify(nonMember.body)})`);
        assert.ok(String(nonMember.body?.error ?? "").toLowerCase().includes("member"), "422 error must mention membership");
        assert.equal(await countAssignments(), before, "C: nothing may be written on 422");
        console.log("  ✓ C: supported-role non-member is rejected without writes");

        // ── (D) unknown/archived client → all-or-nothing 400 ─────────────
        const archived = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID, responsibility: "checker", userId: MEMBER_ID,
          clientIds: [CLIENT_A, CLIENT_ARCHIVED],
        });
        assert.equal(archived.status, 400, `archived client in batch must be 400 (got ${archived.status})`);
        assert.ok(String(archived.body?.error ?? "").includes(CLIENT_ARCHIVED), "400 error must name the bad client");
        const rowA = await db.execute(sql`
          SELECT * FROM sd_client_dept_assignments WHERE client_id = ${CLIENT_A} AND department_id = ${DEPT_ID}
        `);
        assert.equal((rowA as any).rows.length, 0, "D: valid client in a rejected batch must NOT be written (all-or-nothing)");
        console.log("  ✓ D: unknown/archived client rejects the whole batch, no partial writes");

        // ── (E) successful bulk apply + audit ─────────────────────────────
        const ok = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID, responsibility: "checker", userId: MEMBER_ID,
          clientIds: [CLIENT_A, CLIENT_B],
        });
        assert.equal(ok.status, 200, `bulk apply must be 200 (got ${ok.status}: ${JSON.stringify(ok.body)})`);
        assert.equal(ok.body?.updated, 2, "updated count must be 2");
        assert.ok(ok.body?.auditId, "response must include auditId");
        assert.ok(
          Object.prototype.hasOwnProperty.call(ok.body, "projection"),
          "neutral bulk response must expose the honest projection envelope",
        );

        const changes = ok.body.changes as { clientId: string; previousUserId: string | null; newUserId: string | null; overwritten: boolean }[];
        const chA = changes.find((c) => c.clientId === CLIENT_A);
        const chB = changes.find((c) => c.clientId === CLIENT_B);
        assert.ok(chA && chB, "changes must cover both clients");
        assert.equal(chA!.previousUserId, null, "CLIENT_A had no checker before");
        assert.equal(chA!.overwritten, false, "CLIENT_A fill is not an overwrite");
        assert.equal(chB!.previousUserId, MEMBER2_ID, "CLIENT_B previous checker must be reported");
        assert.equal(chB!.overwritten, true, "CLIENT_B change is an overwrite");

        const after = await db.execute(sql`
          SELECT client_id, primary_user_id, checker_user_id
          FROM sd_client_dept_assignments WHERE department_id = ${DEPT_ID}
        `);
        const byClient = new Map((after as any).rows.map((r: any) => [r.client_id, r]));
        assert.equal((byClient.get(CLIENT_A) as any)?.checker_user_id, MEMBER_ID, "E: CLIENT_A checker set");
        assert.equal((byClient.get(CLIENT_B) as any)?.checker_user_id, MEMBER_ID, "E: CLIENT_B checker overwritten");
        assert.equal((byClient.get(CLIENT_B) as any)?.primary_user_id, MEMBER2_ID, "E: CLIENT_B primary must be untouched by checker bulk");

        const audit = await db.execute(sql`
          SELECT * FROM admin_setting_audit WHERE id = ${ok.body.auditId}
        `);
        const auditRow = (audit as any).rows[0];
        assert.ok(auditRow, "E: audit row must exist");
        assert.equal(auditRow.setting_key, "sd_role_assignments_bulk", "audit settingKey");
        assert.equal(auditRow.scope, DEPT_ID, "audit scope = departmentId");
        assert.equal(auditRow.changed_by, LEAD_ID, "audit changedBy = acting team lead");
        const oldVals = auditRow.old_values;
        const newVals = auditRow.new_values;
        assert.equal(newVals.userId, MEMBER_ID, "audit newValues.userId");
        assert.equal(newVals.responsibility, "checker", "audit newValues.responsibility");
        assert.ok(Array.isArray(newVals.clientIds) && newVals.clientIds.length === 2, "audit newValues.clientIds");
        assert.ok(
          (oldVals.previous as any[]).some((p) => p.clientId === CLIENT_B && p.userId === MEMBER2_ID),
          "audit oldValues must record CLIENT_B's previous checker",
        );
        console.log("  ✓ E: bulk apply fills + overwrites only the target role, records the audit change set");

        // ── (F) bulk clear ────────────────────────────────────────────────
        const clear = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID, responsibility: "checker", userId: null, clientIds: [CLIENT_A],
        });
        assert.equal(clear.status, 200, `bulk clear must be 200 (got ${clear.status})`);
        const cleared = await db.execute(sql`
          SELECT checker_user_id FROM sd_client_dept_assignments
          WHERE client_id = ${CLIENT_A} AND department_id = ${DEPT_ID}
        `);
        assert.equal((cleared as any).rows[0].checker_user_id, null, "F: checker cleared");
        console.log("  ✓ F: bulk clear (userId null) empties the role slot");

        // ── (G) coverage per-role gap + stale fields ──────────────────────
        // CLIENT_A: no doer (no dept default), no checker (cleared in F).
        // CLIENT_B: doer MEMBER2 (active), checker MEMBER (active); make the
        // checker STALE by deactivating MEMBER's membership directly.
        await db.execute(sql`
          UPDATE sd_department_members SET active = false
          WHERE department_id = ${DEPT_ID} AND user_id = ${MEMBER_ID}
        `);
        const cov = await req(baseUrl, "GET", COVERAGE_PATH);
        assert.equal(cov.status, 200, "coverage must be 200");
        const rows = cov.body.rows as any[];
        const rA = rows.find((r) => r.clientId === CLIENT_A && r.departmentId === DEPT_ID);
        const rB = rows.find((r) => r.clientId === CLIENT_B && r.departmentId === DEPT_ID);
        assert.ok(rA && rB, "coverage must include both client rows");

        assert.equal(rA.missingDoer, true, "G: A missingDoer");
        assert.equal(rA.missingChecker, true, "G: A missingChecker");
        assert.equal(rA.stalePrimary, false, "G: A no stale primary (none assigned)");

        assert.equal(rB.missingDoer, false, "G: B has an active doer");
        assert.equal(rB.staleChecker, true, "G: B checker is stale (deactivated member)");
        assert.equal(rB.missingChecker, true, "G: B stale checker counts as a checker gap");
        assert.equal(rB.checkerUserId, MEMBER_ID, "G: B stale checker still reported");
        assert.equal(rB.roleStates.checker.source, "client_override", "G: checker source must be explicit");
        assert.equal(rB.roleStates.checker.stale, true, "G: neutral role state must expose stale membership");
        assert.deepEqual(
          Object.keys(rB.roleStates).sort(),
          ["checker", "doer"],
          "G: Checker-capable coverage roleStates have exactly the final Doer/Checker shape",
        );
        assert.equal(cov.body.projectionConfigured, false, "G: missing ClickUp list config is explicit");
        const defaultDenyRow = rows.find(
          (r) => r.clientId === CLIENT_A && r.departmentId === DEFAULT_DENY_DEPT_ID,
        );
        assert.ok(defaultDenyRow, "G: coverage includes the new Doer-only department");
        for (const checkerField of [
          "checkerUserId",
          "defaultCheckerUserId",
          "missingChecker",
          "staleChecker",
        ]) {
          assert.equal(
            Object.prototype.hasOwnProperty.call(defaultDenyRow, checkerField),
            false,
            `G: Doer-only coverage reads must omit unsupported ${checkerField}`,
          );
        }
        assert.equal(
          Object.prototype.hasOwnProperty.call(defaultDenyRow.roleStates, "checker"),
          false,
          "G: Doer-only coverage reads must omit the unsupported Checker role state",
        );
        console.log("  ✓ G: coverage exposes Doer/Checker gaps and role states");

        // ── (H) Task #4171 — company-scope dept: bulk 422 + coverage split ──
        // Department-level holders: doer MEMBER2 (active), checker MEMBER
        // (deactivated in G → stale).
        await db.execute(sql`
          UPDATE sd_departments
          SET assignment_scope = 'company',
              default_primary_user_id = ${MEMBER2_ID},
              default_checker_user_id = ${MEMBER_ID}
          WHERE id = ${DEPT_ID}
        `);

        const beforeH = await countAssignments();
        const companyBulk = await req(baseUrl, "POST", BULK_PATH, {
          departmentId: DEPT_ID, responsibility: "checker", userId: MEMBER2_ID, clientIds: [CLIENT_A],
        });
        assert.equal(
          companyBulk.status, 422,
          `H: bulk against a company-scope dept must be 422 (got ${companyBulk.status}: ${JSON.stringify(companyBulk.body)})`,
        );
        assert.ok(
          String(companyBulk.body?.error ?? "").includes("company-wide"),
          "H: 422 error must explain the department is company-wide",
        );
        assert.equal(await countAssignments(), beforeH, "H: nothing may be written on company 422");

        const covH = await req(baseUrl, "GET", COVERAGE_PATH);
        assert.equal(covH.status, 200, "H: coverage must be 200");
        assert.ok(Array.isArray(covH.body?.companyRows), "H: coverage response must include companyRows array");
        assert.equal(
          (covH.body.rows as any[]).filter((r) => r.departmentId === DEPT_ID).length,
          0,
          "H: company dept must have NO per-client coverage rows",
        );
        assert.ok(
          (covH.body.departments as any[]).some((d) => d.id === DEPT_ID),
          "H: departments list still includes the company dept",
        );
        const compRow = (covH.body.companyRows as any[]).find((r) => r.departmentId === DEPT_ID);
        assert.ok(compRow, "H: companyRows must include the company dept");
        assert.equal(compRow.primaryUserId, MEMBER2_ID, "H: company doer = dept-level holder");
        assert.equal(compRow.missingDoer, false, "H: active company doer is not a gap");
        assert.equal(compRow.checkerUserId, MEMBER_ID, "H: company checker still reported");
        assert.equal(compRow.staleChecker, true, "H: inactive company checker is stale");
        assert.equal(compRow.missingChecker, true, "H: stale company checker counts as a gap");
        assert.equal(compRow.roleStates.doer.source, "company", "H: company role source must be explicit");
        console.log("  ✓ H: company dept — bulk 422 + coverage splits it into companyRows (Task #4171)");

        // ── (I) Task #4171 — per-role default fallback in coverage ────────
        // Back to per_client; defaults: doer none, checker MEMBER2 (active).
        await db.execute(sql`
          UPDATE sd_departments
          SET assignment_scope = 'per_client',
              default_primary_user_id = NULL,
              default_checker_user_id = ${MEMBER2_ID}
          WHERE id = ${DEPT_ID}
        `);

        const covI = await req(baseUrl, "GET", COVERAGE_PATH);
        const rowsI = covI.body.rows as any[];
        const iA = rowsI.find((r) => r.clientId === CLIENT_A && r.departmentId === DEPT_ID);
        const iB = rowsI.find((r) => r.clientId === CLIENT_B && r.departmentId === DEPT_ID);
        assert.ok(iA && iB, "I: per-client rows are back after flipping to per_client");

        // CLIENT_A: empty checker slot + ACTIVE default checker → covered.
        assert.equal(iA.checkerUserId, null, "I: A has no assigned checker");
        assert.equal(iA.defaultCheckerUserId, MEMBER2_ID, "I: A row reports the dept default checker");
        assert.equal(iA.missingChecker, false, "I: active default checker covers the empty slot");
        assert.equal(iA.roleStates.checker.source, "default", "I: default fallback is marked inherited");
        // CLIENT_A: no doer anywhere → gap, hasCoverage false.
        assert.equal(iA.missingDoer, true, "I: A missingDoer (no assignment, no default)");
        assert.equal(iA.hasCoverage, false, "I: hasCoverage tracks the doer slot");

        // CLIENT_B: assigned checker MEMBER is stale, but an ASSIGNED person
        // blocks the default fallback → still a gap despite the active default.
        assert.equal(iB.checkerUserId, MEMBER_ID, "I: B stale assigned checker still reported");
        assert.equal(iB.staleChecker, true, "I: B assigned checker is stale");
        assert.equal(iB.missingChecker, true, "I: stale assigned checker blocks default fallback → gap");
        console.log("  ✓ I: coverage per-role default fallback — active default covers, stale default/assigned block (Task #4171)");

        // ── (J) Neutral inline/default/member routes share the boundary ────
        const defaults = await req(
          baseUrl,
          "PUT",
          `/api/admin/role-assignments/departments/${DEPT_ID}`,
          {
            defaultPrimaryUserId: null,
            defaultCheckerUserId: MEMBER2_ID,
          },
        );
        assert.equal(defaults.status, 200, `J: neutral defaults PUT must be 200 (${JSON.stringify(defaults.body)})`);
        assert.ok(defaults.body?.auditId, "J: neutral defaults PUT must be audited");
        assert.ok(
          Object.prototype.hasOwnProperty.call(defaults.body, "projection"),
          "J: neutral defaults PUT must expose the honest projection envelope",
        );

        const inline = await req(
          baseUrl,
          "PUT",
          `/api/admin/role-assignments/clients/${CLIENT_A}/departments/${DEPT_ID}`,
          {
            primaryUserId: MEMBER2_ID,
            checkerUserId: null,
          },
        );
        assert.equal(inline.status, 200, `J: neutral client assignment PUT must be 200 (${JSON.stringify(inline.body)})`);
        assert.ok(
          Object.prototype.hasOwnProperty.call(inline.body, "projection"),
          "J: neutral client assignment PUT must expose the honest projection envelope",
        );
        const assignmentBeforeUnknownKey = await db.execute(sql`
          SELECT primary_user_id, checker_user_id
          FROM sd_client_dept_assignments
          WHERE client_id = ${CLIENT_A} AND department_id = ${DEPT_ID}
        `);
        const commandsBeforeUnknownKey = await db.execute(sql`
          SELECT count(*)::int AS n FROM cu_role_projection_commands
        `);
        const unknownKeyInline = await req(
          baseUrl,
          "PUT",
          `/api/admin/role-assignments/clients/${CLIENT_A}/departments/${DEPT_ID}`,
          { primaryUserId: null, checkerUserId: MEMBER2_ID, supervisorUserId: null },
        );
        assert.equal(unknownKeyInline.status, 400, "J: unknown supervisorUserId key must be 400");
        const assignmentAfterUnknownKey = await db.execute(sql`
          SELECT primary_user_id, checker_user_id
          FROM sd_client_dept_assignments
          WHERE client_id = ${CLIENT_A} AND department_id = ${DEPT_ID}
        `);
        const commandsAfterUnknownKey = await db.execute(sql`
          SELECT count(*)::int AS n FROM cu_role_projection_commands
        `);
        assert.deepEqual(
          (assignmentAfterUnknownKey as any).rows,
          (assignmentBeforeUnknownKey as any).rows,
          "J: rejected unknown-key inline payload must preserve Doer/Checker state",
        );
        assert.deepEqual(
          (commandsAfterUnknownKey as any).rows,
          (commandsBeforeUnknownKey as any).rows,
          "J: rejected unknown-key inline payload must not stage projection work",
        );

        const invalidInline = await req(
          baseUrl,
          "PUT",
          `/api/admin/role-assignments/clients/${CLIENT_A}/departments/${DEPT_ID}`,
          {
            primaryUserId: MEMBER2_ID,
            checkerUserId: null,
            unexpectedProjectionOverride: true,
          },
        );
        assert.equal(invalidInline.status, 400, "J: neutral client PUT rejects unknown fields");

        const assignmentBeforeEmptyBody = await db.execute(sql`
          SELECT primary_user_id, checker_user_id
          FROM sd_client_dept_assignments
          WHERE client_id = ${CLIENT_A} AND department_id = ${DEPT_ID}
        `);
        const commandCountBeforeEmptyBody = await db.execute(sql`
          SELECT count(*)::int AS n FROM cu_role_projection_commands
        `);
        const emptyInline = await req(
          baseUrl,
          "PUT",
          `/api/admin/role-assignments/clients/${CLIENT_A}/departments/${DEPT_ID}`,
          {},
        );
        assert.equal(emptyInline.status, 400, "J: empty client PUT must be rejected instead of clearing every role");
        const assignmentAfterEmptyBody = await db.execute(sql`
          SELECT primary_user_id, checker_user_id
          FROM sd_client_dept_assignments
          WHERE client_id = ${CLIENT_A} AND department_id = ${DEPT_ID}
        `);
        const commandCountAfterEmptyBody = await db.execute(sql`
          SELECT count(*)::int AS n FROM cu_role_projection_commands
        `);
        assert.deepEqual(
          (assignmentAfterEmptyBody as any).rows,
          (assignmentBeforeEmptyBody as any).rows,
          "J: rejected empty client PUT must preserve NoBull assignments",
        );
        assert.equal(
          (commandCountAfterEmptyBody as any).rows[0].n,
          (commandCountBeforeEmptyBody as any).rows[0].n,
          "J: rejected empty client PUT must not stage projection commands",
        );

        const invalidDefaults = await req(
          baseUrl,
          "PUT",
          `/api/admin/role-assignments/departments/${DEPT_ID}`,
          {
            defaultCheckerUserId: MEMBER2_ID,
            unexpectedProjectionOverride: true,
          },
        );
        assert.equal(invalidDefaults.status, 400, "J: neutral defaults PUT rejects unknown fields");

        const departmentBeforeUnknownKey = await db.execute(sql`
          SELECT default_primary_user_id, default_checker_user_id
          FROM sd_departments WHERE id = ${DEPT_ID}
        `);
        const auditBeforeUnknownKey = await db.execute(sql`
          SELECT count(*)::int AS n FROM admin_setting_audit
        `);
        const unknownKeyDefaults = await req(
          baseUrl,
          "PUT",
          `/api/admin/role-assignments/departments/${DEPT_ID}`,
          { defaultCheckerUserId: null, defaultSupervisorUserId: null },
        );
        assert.equal(unknownKeyDefaults.status, 400, "J: unknown defaultSupervisorUserId key must be 400");
        const departmentAfterUnknownKey = await db.execute(sql`
          SELECT default_primary_user_id, default_checker_user_id
          FROM sd_departments WHERE id = ${DEPT_ID}
        `);
        const auditAfterUnknownKey = await db.execute(sql`
          SELECT count(*)::int AS n FROM admin_setting_audit
        `);
        assert.deepEqual(
          (departmentAfterUnknownKey as any).rows,
          (departmentBeforeUnknownKey as any).rows,
          "J: rejected unknown-key default payload must preserve department state",
        );
        assert.deepEqual(
          (auditAfterUnknownKey as any).rows,
          (auditBeforeUnknownKey as any).rows,
          "J: rejected unknown-key default payload must not write audit state",
        );

        const clientState = await req(
          baseUrl,
          "GET",
          `/api/admin/role-assignments/clients/${CLIENT_A}`,
        );
        assert.equal(clientState.status, 200, "J: neutral client assignment GET must be 200");
        const snapshot = (clientState.body.resolvedAssignments as any[]).find(
          (entry) => entry.departmentId === DEPT_ID,
        );
        assert.ok(snapshot, "J: neutral client GET returns the department snapshot");
        assert.equal(snapshot.roles.doer.source, "client_override", "J: explicit Doer source");
        assert.equal(snapshot.roles.checker.source, "default", "J: inherited Checker source");
        assert.equal(
          clientState.body.membersByDept[INACTIVE_DEPT_ID],
          undefined,
          "J: single-client reads must not return memberships for inactive departments",
        );

        const members = await req(
          baseUrl,
          "GET",
          `/api/admin/role-assignments/departments/${DEPT_ID}/members`,
        );
        assert.equal(members.status, 200, "J: neutral members GET must be 200");
        const member2 = (members.body.members as any[]).find((member) => member.userId === MEMBER2_ID);
        assert.ok(member2, "J: neutral members GET includes the active role-eligible member");

        const removed = await req(
          baseUrl,
          "DELETE",
          `/api/admin/role-assignments/departments/${DEPT_ID}/members/${member2.id}`,
        );
        assert.equal(removed.status, 200, "J: neutral member DELETE must be 200");
        assert.ok(
          (removed.body.clearedAssignments as any[]).some((entry) => entry.clientId === CLIENT_A),
          "J: removing eligibility clears the explicit client assignment through the shared boundary",
        );
        assert.equal(
          removed.body.clearedDepartmentSlots.clearedChecker,
          true,
          "J: removing eligibility clears the inherited department default",
        );
        console.log("  ✓ J: neutral inline, default, client-state, and member routes share assignment semantics");

        // ── (K) Projection diagnostics survive the safe HTTP boundary ──────
        await db.execute(sql`
          INSERT INTO cu_role_projection_destinations
            (id, workspace_id, department_id, responsibility, target_kind, list_id, target_id,
             people_field_id, max_people, environment, enabled)
          VALUES (
            ${PROJECTION_DEST_ID}, 'ws-3626', ${DEPT_ID}, 'checker', 'direct_task',
            'list-3626', 'task-3626', 'people-field-3626', 1, 'sandbox', true
          )
        `);
        await db.execute(sql`
          INSERT INTO cu_role_projection_commands
            (client_id, destination_id, desired_user_id, desired_clickup_user_id, revision,
             target_snapshot, status, last_error_code, last_error, attempt_count, max_attempts,
             mutation_attempts, next_attempt_at)
          VALUES (
            ${CLIENT_A}, ${PROJECTION_DEST_ID}, ${MEMBER_ID}, '998877', 'rev-3626-status',
            ${JSON.stringify({
              targetId: "task-3626",
              listId: "list-3626",
              peopleFieldId: "people-field-3626",
              targetKind: "direct_task",
            })}::jsonb,
            'pending', 'rate_limited', 'ClickUp returned 429', 3, 7, 1, now() + interval '2 minutes'
          )
        `);

        const projectionStatus = await req(
          baseUrl,
          "GET",
          "/api/service-desk/role-projections/status?problemOnly=true",
        );
        assert.equal(
          projectionStatus.status,
          200,
          `K: projection status GET must be 200 (${JSON.stringify(projectionStatus.body)})`,
        );
        assert.equal(projectionStatus.body?.environment, "sandbox", "K: status reports sandbox environment");
        assert.equal(projectionStatus.body?.statuses?.length, 1, "K: problem status query returns the seeded row");
        const projectionRow = projectionStatus.body.statuses[0];
        assert.equal(projectionRow.lastErrorCode, "rate_limited", "K: safe payload preserves vendor error code");
        assert.equal(projectionRow.desiredClickupUserId, "998877", "K: safe payload preserves desired ClickUp person");
        assert.equal(projectionRow.attemptCount, 3, "K: safe payload preserves attempt count");
        assert.equal(projectionRow.maxAttempts, 7, "K: safe payload preserves max-attempt budget");
        assert.equal(
          projectionRow.resyncEligible,
          false,
          "K: pending command is not eligible for manual Re-sync",
        );
        assert.ok(projectionRow.nextAttemptAt, "K: safe payload preserves next retry time");
        assert.equal(
          Object.prototype.hasOwnProperty.call(projectionRow, "observedClickupUserIds"),
          false,
          "K: safe payload still omits raw observed vendor values",
        );

        const pendingResync = await req(
          baseUrl,
          "POST",
          "/api/service-desk/role-projections/resync",
          {
            clientId: CLIENT_A,
            departmentId: DEPT_ID,
            responsibility: "checker",
          },
        );
        assert.equal(pendingResync.status, 409, "K: pending command Re-sync must conflict");
        assert.equal(pendingResync.body.queued, 0, "K: pending command Re-sync queues nothing");
        let commandState = await db.execute(sql`
          SELECT status, attempt_count, mutation_attempts, next_attempt_at,
                 lease_owner, lease_token, lease_expires_at, terminal_at
          FROM cu_role_projection_commands
          WHERE client_id = ${CLIENT_A} AND destination_id = ${PROJECTION_DEST_ID}
        `);
        assert.equal((commandState as any).rows[0].status, "pending", "K: pending status is preserved");
        assert.equal((commandState as any).rows[0].attempt_count, 3, "K: pending attempts are preserved");
        assert.equal((commandState as any).rows[0].mutation_attempts, 1, "K: pending mutations are preserved");
        assert.ok((commandState as any).rows[0].next_attempt_at, "K: pending retry time is preserved");

        await db.execute(sql`
          UPDATE cu_role_projection_commands
          SET status = 'ambiguous',
              attempt_count = 4,
              mutation_attempts = 2,
              next_attempt_at = now() + interval '3 minutes',
              terminal_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL
          WHERE client_id = ${CLIENT_A} AND destination_id = ${PROJECTION_DEST_ID}
        `);
        const ambiguousResync = await req(
          baseUrl,
          "POST",
          "/api/service-desk/role-projections/resync",
          {
            clientId: CLIENT_A,
            departmentId: DEPT_ID,
            responsibility: "checker",
          },
        );
        assert.equal(ambiguousResync.status, 409, "K: ambiguous command Re-sync must conflict");
        assert.match(
          ambiguousResync.body.error,
          /ambiguous commands continue through the projection worker/,
          "K: ambiguous conflict explains the read-before-write continuation path",
        );
        commandState = await db.execute(sql`
          SELECT status, attempt_count, mutation_attempts, next_attempt_at
          FROM cu_role_projection_commands
          WHERE client_id = ${CLIENT_A} AND destination_id = ${PROJECTION_DEST_ID}
        `);
        assert.equal((commandState as any).rows[0].status, "ambiguous", "K: ambiguous status is preserved");
        assert.equal((commandState as any).rows[0].attempt_count, 4, "K: ambiguous attempts are preserved");
        assert.equal((commandState as any).rows[0].mutation_attempts, 2, "K: ambiguous mutations are preserved");
        assert.ok((commandState as any).rows[0].next_attempt_at, "K: ambiguous retry time is preserved");

        await db.execute(sql`
          UPDATE cu_role_projection_commands
          SET status = 'failed',
              attempt_count = 7,
              mutation_attempts = 4,
              next_attempt_at = NULL,
              terminal_at = now(),
              lease_owner = 'worker-under-test',
              lease_token = 'lease-under-test',
              lease_expires_at = now() + interval '5 minutes'
          WHERE client_id = ${CLIENT_A} AND destination_id = ${PROJECTION_DEST_ID}
        `);
        const leasedResync = await req(
          baseUrl,
          "POST",
          "/api/service-desk/role-projections/resync",
          {
            clientId: CLIENT_A,
            departmentId: DEPT_ID,
            responsibility: "checker",
          },
        );
        assert.equal(leasedResync.status, 409, "K: leased command Re-sync must conflict");
        commandState = await db.execute(sql`
          SELECT status, attempt_count, mutation_attempts, lease_owner, lease_token,
                 lease_expires_at, terminal_at
          FROM cu_role_projection_commands
          WHERE client_id = ${CLIENT_A} AND destination_id = ${PROJECTION_DEST_ID}
        `);
        assert.equal((commandState as any).rows[0].status, "failed", "K: leased status is preserved");
        assert.equal((commandState as any).rows[0].attempt_count, 7, "K: leased attempts are preserved");
        assert.equal((commandState as any).rows[0].mutation_attempts, 4, "K: leased mutations are preserved");
        assert.equal(
          (commandState as any).rows[0].lease_token,
          "lease-under-test",
          "K: active lease is preserved",
        );
        assert.ok((commandState as any).rows[0].terminal_at, "K: leased terminal marker is preserved");
        const leasedProjectionStatus = await req(
          baseUrl,
          "GET",
          "/api/service-desk/role-projections/status?problemOnly=true",
        );
        assert.equal(
          leasedProjectionStatus.body.statuses[0].resyncEligible,
          false,
          "K: safe status response hides Re-sync eligibility while a lease is present",
        );
        for (const leaseField of ["leaseOwner", "leaseToken", "leaseExpiresAt"]) {
          assert.equal(
            Object.prototype.hasOwnProperty.call(leasedProjectionStatus.body.statuses[0], leaseField),
            false,
            `K: safe status response does not expose ${leaseField}`,
          );
        }

        await db.execute(sql`
          UPDATE cu_role_projection_commands
          SET lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL
          WHERE client_id = ${CLIENT_A} AND destination_id = ${PROJECTION_DEST_ID}
        `);
        const eligibleProjectionStatus = await req(
          baseUrl,
          "GET",
          "/api/service-desk/role-projections/status?problemOnly=true",
        );
        assert.equal(
          eligibleProjectionStatus.body.statuses[0].resyncEligible,
          true,
          "K: terminal failed command becomes Re-sync eligible only after its lease is gone",
        );
        const failedResync = await req(
          baseUrl,
          "POST",
          "/api/service-desk/role-projections/resync",
          {
            clientId: CLIENT_A,
            departmentId: DEPT_ID,
            responsibility: "checker",
          },
        );
        assert.equal(failedResync.status, 200, "K: failed unleased command Re-sync must be accepted");
        assert.equal(failedResync.body.queued, 1, "K: eligible Re-sync queues one durable command wake");
        commandState = await db.execute(sql`
          SELECT status, attempt_count, mutation_attempts, lease_owner, lease_token,
                 lease_expires_at, terminal_at
          FROM cu_role_projection_commands
          WHERE client_id = ${CLIENT_A} AND destination_id = ${PROJECTION_DEST_ID}
        `);
        assert.equal((commandState as any).rows[0].status, "pending", "K: eligible command resets to pending");
        assert.equal((commandState as any).rows[0].attempt_count, 0, "K: eligible attempts reset");
        assert.equal((commandState as any).rows[0].mutation_attempts, 0, "K: eligible mutations reset");
        assert.equal((commandState as any).rows[0].terminal_at, null, "K: eligible terminal marker clears");

        console.log(
          "  ✓ K: safe diagnostics and failed/blocked-only unleased Re-sync survive the HTTP boundary",
        );
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  await getGlobalDispatcher().close();

  console.log("sd-role-assignments-bulk-route: all sections passed (Task #3626).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("sd-role-assignments-bulk-route: FAILED —", err?.stack ?? err, err?.cause ?? "");
    process.exit(1);
  },
);
