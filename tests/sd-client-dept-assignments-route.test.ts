/* test-registration
{
  "name": "Service Desk client×dept assignments — 401/403/200 gates + UPSERT + coverage grid (Task #3585)",
  "regression": true,
  "sweepOnlyReason": "Task #3585 — DB-heavy (runInIsolatedSchema: users, clients, sd_departments, sd_client_dept_assignments) + real HTTP; not a smoke-gate candidate.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3585 — Route-level regression guard for client×department SD assignment APIs.
 *
 * Three endpoints:
 *   GET  /api/service-desk/clients/:clientId/assignments
 *   PUT  /api/service-desk/clients/:clientId/assignments/:departmentId
 *   GET  /api/service-desk/coverage
 *
 * All assignment/coverage routes are gated by requireTeamLead.
 * Department PUT is gated by requireCeo.
 *
 * Sections:
 *   (A) Unauthenticated → 401
 *   (B) account_manager → 403
 *   (C) team_lead GET assignments → 200 with { assignments, departments, membersByDept }
 *   (D) PUT assignment eligibility: non-member → 422; active-member/null → 200;
 *       any retired supervisorUserId key → 400 with no mutation
 *   (E) GET coverage → 200 with { rows, departments, membersByDept }
 *   (F) PUT department defaultPrimaryUserId: non-member → 422; active-member → 200
 *   (G/H/H2) member removal clears assignments; stale references are gaps (Task #3586)
 *   (I) Task #4171 — assignmentScope PUT: CEO-only, bad value → 400, company
 *       flip blocks per-client assignment PUTs with 422
 *   (J) Task #4171/#5234 — PUT /departments/:id/role-defaults: 401/403
 *       gates, 404 unknown dept, 400 empty/Supervisor body, Checker
 *       eligibility, team_lead Doer/Checker update + admin_setting_audit row
 *   (K) Task #4171 — member removal also clears department-level default
 *       slots and reports clearedDepartmentSlots
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
import {
  PAID_SEARCH_DEPARTMENT_ID,
  sdDepartments,
  sdClientDeptAssignments,
  sdDepartmentMembers,
} from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const LEAD_ID = "test-3585-lead";
const AM_ID = "test-3585-am";
const CEO_ID = "test-3585-ceo";
const CLIENT_ID = "test-3585-client";
const DEPT_ID = PAID_SEARCH_DEPARTMENT_ID;

const TABLES = [
  "users",
  "clients",
  "sd_list_mapping",
  "sd_departments",
  "sd_department_members",
  "sd_client_dept_assignments",
  "admin_setting_audit",
] as const;

let activeUserId: string | null = LEAD_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a
    // string authenticates as that user id; null models an anonymous
    // request (→ 401). Users are seeded in the isolated sandbox schema, so
    // pre-register their profiles via __test_markUserReconciled below.
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

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function put(
  baseUrl: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed actors ────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES
          (${LEAD_ID}, 'team_lead', 'Lead 3585'),
          (${AM_ID}, 'account_manager', 'AM 3585'),
          (${CEO_ID}, 'ceo', 'CEO 3585')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Pre-register the sandbox-seeded users so requireAuth resolves them
      // without a public-schema JIT provision (Clerk-era auth seam).
      __test_markUserReconciled(LEAD_ID, { id: LEAD_ID, role: "team_lead", firstName: "Lead 3585" });
      __test_markUserReconciled(AM_ID, { id: AM_ID, role: "account_manager", firstName: "AM 3585" });
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 3585" });

      // ── Seed a client (non-archived) ───────────────────────────────────
      await db.execute(sql`
        INSERT INTO clients (id, firm_name, is_archived)
        VALUES (${CLIENT_ID}, 'Test Firm 3585', false)
        ON CONFLICT (id) DO UPDATE SET firm_name = EXCLUDED.firm_name
      `);

      // ── Seed an active department ──────────────────────────────────────
      await db.insert(sdDepartments).values({
        id: DEPT_ID,
        name: "Paid Search",
        active: true,
        sortOrder: 1,
      }).onConflictDoNothing();

      // ── Seed LEAD_ID as an active member of DEPT_ID ───────────────────
      await db.insert(sdDepartmentMembers).values({
        departmentId: DEPT_ID,
        userId: LEAD_ID,
        active: true,
      }).onConflictDoNothing();

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ────────────────────────────────────────────────────────────────
        // (A) Unauthenticated → 401 on all three endpoints
        // ────────────────────────────────────────────────────────────────
        activeUserId = null;

        const anonGet = await get(baseUrl, `/api/service-desk/clients/${CLIENT_ID}/assignments`);
        assert.equal(anonGet.status, 401, `unauthenticated GET assignments must be 401 (got ${anonGet.status})`);

        const anonPut = await put(baseUrl, `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`, {});
        assert.equal(anonPut.status, 401, `unauthenticated PUT assignment must be 401 (got ${anonPut.status})`);

        const anonCoverage = await get(baseUrl, "/api/service-desk/coverage");
        assert.equal(anonCoverage.status, 401, `unauthenticated GET coverage must be 401 (got ${anonCoverage.status})`);

        console.log("  ✓ A: unauthenticated requests rejected with 401");

        // ────────────────────────────────────────────────────────────────
        // (B) account_manager → 403
        // ────────────────────────────────────────────────────────────────
        activeUserId = AM_ID;

        const amGet = await get(baseUrl, `/api/service-desk/clients/${CLIENT_ID}/assignments`);
        assert.equal(amGet.status, 403, `account_manager GET assignments must be 403 (got ${amGet.status})`);

        const amCoverage = await get(baseUrl, "/api/service-desk/coverage");
        assert.equal(amCoverage.status, 403, `account_manager GET coverage must be 403 (got ${amCoverage.status})`);

        console.log("  ✓ B: account_manager rejected with 403");

        // ────────────────────────────────────────────────────────────────
        // (C) team_lead GET assignments → 200 with { assignments, departments, membersByDept }
        // ────────────────────────────────────────────────────────────────
        activeUserId = LEAD_ID;

        const getResp = await get(baseUrl, `/api/service-desk/clients/${CLIENT_ID}/assignments`);
        assert.equal(getResp.status, 200, `team_lead GET assignments must be 200 (got ${getResp.status}: ${JSON.stringify(getResp.body)})`);
        assert.ok(Array.isArray(getResp.body?.assignments), "response must have assignments array");
        assert.ok(Array.isArray(getResp.body?.departments), "response must have departments array");
        assert.ok(Array.isArray(getResp.body?.resolvedAssignments), "response must have neutral resolvedAssignments array");
        assert.ok(
          getResp.body?.membersByDept !== null && typeof getResp.body?.membersByDept === "object",
          "response must have membersByDept object",
        );

        const depts = getResp.body.departments as { id: string; name: string }[];
        const seededDept = depts.find((d) => d.id === DEPT_ID);
        assert.ok(seededDept, `seeded department ${DEPT_ID} must appear in departments list`);
        assert.equal(seededDept!.name, "Paid Search", "department name must match seeded value");

        const membersByDept = getResp.body.membersByDept as Record<string, string[]>;
        assert.ok(
          Array.isArray(membersByDept[DEPT_ID]),
          `membersByDept must contain an array for dept ${DEPT_ID}`,
        );
        assert.ok(
          membersByDept[DEPT_ID].includes(LEAD_ID),
          `membersByDept[${DEPT_ID}] must include the seeded member ${LEAD_ID}`,
        );
        const resolved = (getResp.body.resolvedAssignments as any[]).find(
          (assignment) => assignment.departmentId === DEPT_ID,
        );
        assert.ok(resolved, "resolvedAssignments must expose the stable department id");
        assert.equal(resolved.clientId, CLIENT_ID, "resolved assignment must expose the stable client id");
        assert.equal(resolved.roles.doer.eligibility, "unassigned", "empty role eligibility is explicit");
        assert.equal(
          Object.prototype.hasOwnProperty.call(resolved.roles, "supervisor"),
          false,
          "resolved roles must omit the retired Supervisor state",
        );
        assert.ok(typeof resolved.revision === "string" && resolved.revision.length > 0, "revision is exposed");
        assert.ok(resolved.freshness?.computedAt, "freshness is exposed");

        console.log("  ✓ C: team_lead GET assignments returns compatibility + neutral assignment contract");

        // ────────────────────────────────────────────────────────────────
        // (D) PUT assignment eligibility checks
        //   D1: non-member userId → 422
        //   D2: active-member userId → 200
        //   D3: null userId → 200 (no eligibility check, idempotent UPSERT)
        // ────────────────────────────────────────────────────────────────

        // D1: AM_ID is NOT a member of DEPT_ID → 422
        const putNonMember = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: AM_ID, checkerUserId: null },
        );
        assert.equal(
          putNonMember.status, 422,
          `PUT assignment with non-member primaryUserId must be 422 (got ${putNonMember.status}: ${JSON.stringify(putNonMember.body)})`,
        );
        assert.ok(
          String(putNonMember.body?.error ?? "").toLowerCase().includes("member"),
          "422 error message must mention membership",
        );

        // D2: LEAD_ID IS an active member of DEPT_ID → 200; set supported roles.
        const putMember = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: LEAD_ID, checkerUserId: LEAD_ID },
        );
        assert.equal(
          putMember.status, 200,
          `PUT assignment with active-member primaryUserId must be 200 (got ${putMember.status}: ${JSON.stringify(putMember.body)})`,
        );
        assert.equal(putMember.body?.assignment?.primaryUserId, LEAD_ID, "assignment.primaryUserId must be LEAD_ID");
        assert.equal(putMember.body?.assignment?.checkerUserId, LEAD_ID, "assignment.checkerUserId must be LEAD_ID");
        assert.equal(
          Object.prototype.hasOwnProperty.call(putMember.body?.assignment ?? {}, "supervisorUserId"),
          false,
          "assignment responses must omit the retired Supervisor slot",
        );

        // D2b: non-member checker remains a membership 422.
        const putBadChecker = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: LEAD_ID, checkerUserId: AM_ID },
        );
        assert.equal(putBadChecker.status, 422, `non-member checkerUserId must be 422 (got ${putBadChecker.status})`);

        // D2c: any retired Supervisor key, including null, is a schema 400 and
        // cannot alter the supported role columns or persisted legacy column.
        const beforeSupervisorAttempts = await db.execute(sql`
          SELECT primary_user_id, checker_user_id
          FROM sd_client_dept_assignments
          WHERE client_id = ${CLIENT_ID} AND department_id = ${DEPT_ID}
        `);
        for (const supervisorUserId of [AM_ID, null]) {
          const retiredSupervisor = await put(
            baseUrl,
            `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
            { primaryUserId: null, checkerUserId: null, supervisorUserId },
          );
          assert.equal(
            retiredSupervisor.status,
            400,
            `retired supervisorUserId=${String(supervisorUserId)} must be 400 (got ${retiredSupervisor.status})`,
          );
        }
        const afterSupervisorAttempts = await db.execute(sql`
          SELECT primary_user_id, checker_user_id
          FROM sd_client_dept_assignments
          WHERE client_id = ${CLIENT_ID} AND department_id = ${DEPT_ID}
        `);
        assert.deepEqual(
          (afterSupervisorAttempts as any).rows,
          (beforeSupervisorAttempts as any).rows,
          "retired Supervisor payloads must not mutate Doer, Checker, or persisted assignment state",
        );

        // D2d: aliases are not accepted by the strict assignment schema.
        const putLegacy = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: LEAD_ID, backupUserId: LEAD_ID },
        );
        assert.equal(putLegacy.status, 400, `backupUserId alias must be rejected (got ${putLegacy.status})`);

        // D3: null userId bypasses eligibility → 200 (idempotent UPSERT)
        const putNull = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: null, checkerUserId: null },
        );
        assert.equal(putNull.status, 200, `PUT assignment with null primaryUserId must be 200 (got ${putNull.status})`);
        assert.equal(putNull.body?.assignment?.primaryUserId, null, "primaryUserId must be null after clearing");
        assert.equal(putNull.body?.assignment?.checkerUserId, null, "checkerUserId must be null after clearing");
        assert.equal(
          Object.prototype.hasOwnProperty.call(putNull.body?.assignment ?? {}, "supervisorUserId"),
          false,
          "cleared assignment response must omit the retired Supervisor slot",
        );

        console.log("  ✓ D: Doer/Checker PUTs preserve eligibility; Supervisor keys are 400 with no mutation");

        // ────────────────────────────────────────────────────────────────
        // (E) GET coverage → 200 with { rows, departments, membersByDept }
        // ────────────────────────────────────────────────────────────────
        const covResp = await get(baseUrl, "/api/service-desk/coverage");
        assert.equal(covResp.status, 200, `GET coverage must be 200 (got ${covResp.status}: ${JSON.stringify(covResp.body)})`);
        assert.ok(Array.isArray(covResp.body?.rows), "coverage response must have rows array");
        assert.ok(Array.isArray(covResp.body?.departments), "coverage response must have departments array");
        assert.ok(
          covResp.body?.membersByDept !== null && typeof covResp.body?.membersByDept === "object",
          "coverage response must have membersByDept object",
        );

        const coverageMembersByDept = covResp.body.membersByDept as Record<string, string[]>;
        assert.ok(
          Array.isArray(coverageMembersByDept[DEPT_ID]) && coverageMembersByDept[DEPT_ID].includes(LEAD_ID),
          `coverage membersByDept[${DEPT_ID}] must include the seeded member ${LEAD_ID}`,
        );

        const rows = covResp.body.rows as {
          clientId: string;
          firmName: string;
          departmentId: string;
          deptName: string;
          hasCoverage: boolean;
        }[];
        const expectedRow = rows.find(
          (r) => r.clientId === CLIENT_ID && r.departmentId === DEPT_ID,
        );
        assert.ok(expectedRow, `coverage must contain row for client ${CLIENT_ID} × dept ${DEPT_ID}`);
        assert.equal(expectedRow!.firmName, "Test Firm 3585", "coverage row firmName must match");
        assert.equal(expectedRow!.deptName, "Paid Search", "coverage row deptName must match");
        assert.equal(expectedRow!.hasCoverage, false, "coverage hasCoverage must be false (no primary assigned, no dept default)");
        for (const retiredField of [
          "supervisorUserId",
          "defaultSupervisorUserId",
          "missingSupervisor",
          "staleSupervisor",
        ]) {
          assert.equal(
            Object.prototype.hasOwnProperty.call(expectedRow!, retiredField),
            false,
            `coverage rows must omit retired Supervisor field ${retiredField}`,
          );
        }

        console.log("  ✓ E: team_lead GET coverage returns 200 with { rows, departments, membersByDept }");

        // ────────────────────────────────────────────────────────────────
        // (F) PUT /api/service-desk/departments/:id defaultPrimaryUserId eligibility
        //   F1: non-member → 422
        //   F2: active-member → 200
        //   F3: null → 200 (clears default)
        // ────────────────────────────────────────────────────────────────
        activeUserId = CEO_ID;

        // F1: AM_ID is NOT a dept member → 422
        const deptPutNonMember = await put(
          baseUrl,
          `/api/service-desk/departments/${DEPT_ID}`,
          { defaultPrimaryUserId: AM_ID },
        );
        assert.equal(
          deptPutNonMember.status, 422,
          `PUT department defaultPrimaryUserId with non-member must be 422 (got ${deptPutNonMember.status}: ${JSON.stringify(deptPutNonMember.body)})`,
        );
        assert.ok(
          String(deptPutNonMember.body?.error ?? "").toLowerCase().includes("member"),
          "422 error message must mention membership",
        );

        // F2: LEAD_ID is an active member → 200
        const deptPutMember = await put(
          baseUrl,
          `/api/service-desk/departments/${DEPT_ID}`,
          { defaultPrimaryUserId: LEAD_ID },
        );
        assert.equal(
          deptPutMember.status, 200,
          `PUT department defaultPrimaryUserId with active-member must be 200 (got ${deptPutMember.status}: ${JSON.stringify(deptPutMember.body)})`,
        );
        assert.equal(
          deptPutMember.body?.department?.defaultPrimaryUserId, LEAD_ID,
          "department.defaultPrimaryUserId must be LEAD_ID after setting",
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(deptPutMember.body?.department ?? {}, "defaultSupervisorUserId"),
          false,
          "department responses must omit the retired Supervisor default",
        );

        const retiredDepartmentDefault = await put(
          baseUrl,
          `/api/service-desk/departments/${DEPT_ID}`,
          { defaultPrimaryUserId: null, defaultSupervisorUserId: null },
        );
        assert.equal(retiredDepartmentDefault.status, 400, "default-configuration Supervisor keys, including null, must be 400");
        const deptAfterRetiredDefault = await db.execute(sql`
          SELECT default_primary_user_id, default_checker_user_id
          FROM sd_departments WHERE id = ${DEPT_ID}
        `);
        assert.deepEqual(
          (deptAfterRetiredDefault as any).rows[0],
          {
            default_primary_user_id: LEAD_ID,
            default_checker_user_id: null,
          },
          "rejected default-configuration Supervisor payload must preserve all department role state",
        );

        // F3: null clears the default
        const deptPutNull = await put(
          baseUrl,
          `/api/service-desk/departments/${DEPT_ID}`,
          { defaultPrimaryUserId: null },
        );
        assert.equal(deptPutNull.status, 200, `PUT department defaultPrimaryUserId=null must be 200`);
        assert.equal(
          deptPutNull.body?.department?.defaultPrimaryUserId, null,
          "department.defaultPrimaryUserId must be null after clearing",
        );

        console.log("  ✓ F: PUT department defaultPrimaryUserId eligibility: non-member→422, active-member→200, null→200");

        // ────────────────────────────────────────────────────────────────
        // (G) Task #3586 — removing a member clears their assignments and
        //     coverage marks stale primaries as gaps.
        //   G1: assign LEAD_ID as primary, verify coverage=true
        //   G2: deactivate the member (PUT active=false) → clearedAssignments
        //       lists the client, assignment row's primaryUserId is null
        //   G3: coverage row is a gap afterwards
        //   G4: stale primary that somehow survives (seeded directly) is
        //       marked as a gap by the coverage endpoint
        // ────────────────────────────────────────────────────────────────

        // G1: re-assign LEAD_ID in both supported role slots (was cleared in D3)
        // so the member-removal path proves it clears Doer and Checker.
        activeUserId = LEAD_ID;
        const reAssign = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: LEAD_ID, checkerUserId: LEAD_ID },
        );
        assert.equal(reAssign.status, 200, `G1 re-assign must be 200 (got ${reAssign.status})`);

        const covBefore = await get(baseUrl, "/api/service-desk/coverage");
        const rowBefore = (covBefore.body.rows as any[]).find(
          (r) => r.clientId === CLIENT_ID && r.departmentId === DEPT_ID,
        );
        assert.equal(rowBefore?.hasCoverage, true, "G1: coverage must be true with active-member primary");

        // G2: find the member row id, deactivate via PUT active=false
        activeUserId = CEO_ID;
        const membersResp = await get(baseUrl, `/api/service-desk/departments/${DEPT_ID}/members`);
        assert.equal(membersResp.status, 200, "G2: list members must be 200");
        const memberRow = (membersResp.body.members as any[]).find((m) => m.userId === LEAD_ID);
        assert.ok(memberRow, "G2: seeded member row must exist");

        const deactivate = await put(
          baseUrl,
          `/api/service-desk/departments/${DEPT_ID}/members/${memberRow.id}`,
          { active: false },
        );
        assert.equal(deactivate.status, 200, `G2: deactivate member must be 200 (got ${deactivate.status}: ${JSON.stringify(deactivate.body)})`);
        assert.ok(
          Array.isArray(deactivate.body?.clearedAssignments),
          "G2: deactivate response must include clearedAssignments array",
        );
        const cleared = deactivate.body.clearedAssignments as { clientId: string; clearedPrimary: boolean; clearedChecker: boolean }[];
        assert.ok(
          cleared.some((c) => c.clientId === CLIENT_ID && c.clearedPrimary && c.clearedChecker),
          `G2: clearedAssignments must report supported roles cleared for ${CLIENT_ID} (got ${JSON.stringify(cleared)})`,
        );

        // Assignment row must have a null primary now
        activeUserId = LEAD_ID;
        const afterGet = await get(baseUrl, `/api/service-desk/clients/${CLIENT_ID}/assignments`);
        const afterAssignment = (afterGet.body.assignments as any[]).find(
          (a) => a.departmentId === DEPT_ID,
        );
        assert.equal(
          afterAssignment?.primaryUserId, null,
          "G2: assignment.primaryUserId must be null after member deactivation",
        );

        // G3: coverage is now a gap
        const covAfter = await get(baseUrl, "/api/service-desk/coverage");
        const rowAfter = (covAfter.body.rows as any[]).find(
          (r) => r.clientId === CLIENT_ID && r.departmentId === DEPT_ID,
        );
        assert.equal(rowAfter?.hasCoverage, false, "G3: coverage must be a gap after member removal");

        console.log("  ✓ G: member deactivation clears assignments + coverage marks gap (Task #3586)");

        // ────────────────────────────────────────────────────────────────
        // (H) Task #3586 — a stale primaryUserId (seeded directly, e.g.
        //     pre-fix data) is treated as a gap, not coverage.
        // ────────────────────────────────────────────────────────────────
        await db.execute(sql`
          UPDATE sd_client_dept_assignments
          SET primary_user_id = ${LEAD_ID}
          WHERE client_id = ${CLIENT_ID} AND department_id = ${DEPT_ID}
        `);
        const covStale = await get(baseUrl, "/api/service-desk/coverage");
        const rowStale = (covStale.body.rows as any[]).find(
          (r) => r.clientId === CLIENT_ID && r.departmentId === DEPT_ID,
        );
        assert.equal(rowStale?.primaryUserId, LEAD_ID, "H: stale primaryUserId must still be reported");
        assert.equal(rowStale?.hasCoverage, false, "H: stale (inactive-member) primary must be a gap, not coverage");

        console.log("  ✓ H: stale primary referencing an inactive member is marked as a gap (Task #3586)");

        // ────────────────────────────────────────────────────────────────
        // (H2) Task #3586 — effective-resolution semantics: a stale assigned
        //      primary must stay a gap EVEN IF the department has an active
        //      defaultPrimaryUserId, because ticket submission resolves the
        //      assigned primary first and never falls back to the default
        //      when an assignment primary is set.
        // ────────────────────────────────────────────────────────────────
        await db.execute(sql`
          INSERT INTO sd_department_members (department_id, user_id, active)
          VALUES (${DEPT_ID}, ${CEO_ID}, true)
        `);
        await db.execute(sql`
          UPDATE sd_departments
          SET default_primary_user_id = ${CEO_ID}
          WHERE id = ${DEPT_ID}
        `);
        const covStaleDefault = await get(baseUrl, "/api/service-desk/coverage");
        const rowStaleDefault = (covStaleDefault.body.rows as any[]).find(
          (r) => r.clientId === CLIENT_ID && r.departmentId === DEPT_ID,
        );
        assert.equal(
          rowStaleDefault?.defaultPrimaryUserId, CEO_ID,
          "H2: department default must be the active CEO member",
        );
        assert.equal(rowStaleDefault?.primaryUserId, LEAD_ID, "H2: stale assigned primary must still be reported");
        assert.equal(
          rowStaleDefault?.hasCoverage, false,
          "H2: stale assigned primary must be a gap even with an active dept default (assigned primary blocks default fallback)",
        );

        // Sanity: once the stale assigned primary is cleared, the active dept
        // default DOES count as coverage again.
        await db.execute(sql`
          UPDATE sd_client_dept_assignments
          SET primary_user_id = NULL
          WHERE client_id = ${CLIENT_ID} AND department_id = ${DEPT_ID}
        `);
        const covDefaultOnly = await get(baseUrl, "/api/service-desk/coverage");
        const rowDefaultOnly = (covDefaultOnly.body.rows as any[]).find(
          (r) => r.clientId === CLIENT_ID && r.departmentId === DEPT_ID,
        );
        assert.equal(
          rowDefaultOnly?.hasCoverage, true,
          "H2: with no assigned primary, an active dept default counts as coverage",
        );

        console.log("  ✓ H2: stale assigned primary blocks default fallback → gap; default-only → covered (Task #3586)");

        // ────────────────────────────────────────────────────────────────
        // (I) Task #4171 — assignmentScope on PUT /departments/:id
        //   I1: team_lead → 403 (structure changes stay CEO-only)
        //   I2: invalid scope value → 400
        //   I3: CEO flips to company → 200; per-client assignment PUT → 422
        //   I4: flip back to per_client → 200; assignment PUT works again
        // ────────────────────────────────────────────────────────────────
        activeUserId = LEAD_ID;
        const leadScopePut = await put(baseUrl, `/api/service-desk/departments/${DEPT_ID}`, {
          assignmentScope: "company",
        });
        assert.equal(leadScopePut.status, 403, `I1: team_lead PUT department must be 403 (got ${leadScopePut.status})`);

        // Task #4173 — GET /departments reports the per-client assignment
        // footprint so the UI can warn before a scope flip. At this point the
        // row for CLIENT_ID×DEPT_ID has all-null role slots (cleared in H2),
        // so it must NOT count; after seeding a role holder it must count 1
        // with a last-updated hint.
        const deptsEmpty = await get(baseUrl, "/api/service-desk/departments");
        assert.equal(deptsEmpty.status, 200, "I0: GET departments must be 200");
        const deptRowEmpty = (deptsEmpty.body.departments as any[]).find((d) => d.id === DEPT_ID);
        assert.equal(deptRowEmpty?.assignmentCount, 0, "I0: all-null assignment row must not count");
        assert.equal(deptRowEmpty?.lastAssignmentUpdatedAt, null, "I0: no counted rows → null last-updated hint");

        await db.execute(sql`
          UPDATE sd_client_dept_assignments
          SET primary_user_id = ${LEAD_ID}
          WHERE client_id = ${CLIENT_ID} AND department_id = ${DEPT_ID}
        `);
        const deptsCounted = await get(baseUrl, "/api/service-desk/departments");
        const deptRowCounted = (deptsCounted.body.departments as any[]).find((d) => d.id === DEPT_ID);
        assert.equal(deptRowCounted?.assignmentCount, 1, "I0: row with a role holder must count");
        assert.ok(deptRowCounted?.lastAssignmentUpdatedAt, "I0: counted rows must carry a lastAssignmentUpdatedAt hint");

        console.log("  ✓ I0: GET departments reports assignmentCount + lastAssignmentUpdatedAt (Task #4173)");

        activeUserId = CEO_ID;
        const badScope = await put(baseUrl, `/api/service-desk/departments/${DEPT_ID}`, {
          assignmentScope: "global",
        });
        assert.equal(badScope.status, 400, `I2: invalid assignmentScope must be 400 (got ${badScope.status}: ${JSON.stringify(badScope.body)})`);

        const toCompany = await put(baseUrl, `/api/service-desk/departments/${DEPT_ID}`, {
          assignmentScope: "company",
        });
        assert.equal(toCompany.status, 200, `I3: CEO flip to company must be 200 (got ${toCompany.status}: ${JSON.stringify(toCompany.body)})`);
        assert.equal(toCompany.body?.department?.assignmentScope, "company", "I3: department.assignmentScope must be company");

        activeUserId = LEAD_ID;
        const companyAssignPut = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: null, checkerUserId: null },
        );
        assert.equal(
          companyAssignPut.status, 422,
          `I3: per-client assignment PUT for a company dept must be 422 (got ${companyAssignPut.status}: ${JSON.stringify(companyAssignPut.body)})`,
        );
        assert.ok(
          String(companyAssignPut.body?.error ?? "").includes("company-wide"),
          "I3: 422 error must explain the department is company-wide",
        );

        activeUserId = CEO_ID;
        const backToPerClient = await put(baseUrl, `/api/service-desk/departments/${DEPT_ID}`, {
          assignmentScope: "per_client",
        });
        assert.equal(backToPerClient.status, 200, "I4: flip back to per_client must be 200");
        assert.equal(backToPerClient.body?.department?.assignmentScope, "per_client", "I4: scope restored");

        activeUserId = LEAD_ID;
        const perClientAssignPut = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: null, checkerUserId: null },
        );
        assert.equal(perClientAssignPut.status, 200, "I4: assignment PUT must work again after flipping back");

        console.log("  ✓ I: assignmentScope PUT — CEO-only, invalid→400, company blocks per-client assignment PUTs (Task #4171)");

        // ────────────────────────────────────────────────────────────────
        // (J) Task #4171/#5234 — role-default edits retain Doer/Checker while
        //     every retired Supervisor payload is 400 with no state change.
        // ────────────────────────────────────────────────────────────────
        const RD_PATH = `/api/service-desk/departments/${DEPT_ID}/role-defaults`;

        activeUserId = null;
        const rdAnon = await put(baseUrl, RD_PATH, { defaultCheckerUserId: CEO_ID });
        assert.equal(rdAnon.status, 401, `J: unauthenticated role-defaults must be 401 (got ${rdAnon.status})`);

        activeUserId = AM_ID;
        const rdAm = await put(baseUrl, RD_PATH, { defaultCheckerUserId: CEO_ID });
        assert.equal(rdAm.status, 403, `J: account_manager role-defaults must be 403 (got ${rdAm.status})`);

        activeUserId = LEAD_ID;
        const rdUnknown = await put(baseUrl, `/api/service-desk/departments/nope-4171/role-defaults`, {
          defaultCheckerUserId: CEO_ID,
        });
        assert.equal(rdUnknown.status, 404, `J: unknown department must be 404 (got ${rdUnknown.status})`);

        const rdEmpty = await put(baseUrl, RD_PATH, {});
        assert.equal(rdEmpty.status, 400, `J: empty body must be 400 (got ${rdEmpty.status})`);

        // Per-field eligibility: AM_ID is not a department member.
        const rdBadChecker = await put(baseUrl, RD_PATH, { defaultCheckerUserId: AM_ID });
        assert.equal(rdBadChecker.status, 422, `J: non-member default checker must be 422 (got ${rdBadChecker.status})`);
        assert.ok(
          String(rdBadChecker.body?.error ?? "").includes("Default checker"),
          `J: 422 must name the offending field (got ${JSON.stringify(rdBadChecker.body)})`,
        );
        const rdBadSupervisor = await put(baseUrl, RD_PATH, { defaultSupervisorUserId: AM_ID });
        assert.equal(rdBadSupervisor.status, 400, "J: retired default supervisor must be 400 before membership validation");
        const rdNullSupervisor = await put(baseUrl, RD_PATH, { defaultSupervisorUserId: null });
        assert.equal(rdNullSupervisor.status, 400, "J: retired null default supervisor must also be 400");
        const defaultsAfterRejectedSupervisor = await db.execute(sql`
          SELECT default_primary_user_id, default_checker_user_id
          FROM sd_departments WHERE id = ${DEPT_ID}
        `);
        assert.deepEqual(
          (defaultsAfterRejectedSupervisor as any).rows[0],
          {
            default_primary_user_id: CEO_ID,
            default_checker_user_id: null,
          },
          "J: rejected Supervisor defaults must preserve all department role state",
        );

        // Valid: CEO_ID is an active member (seeded in H2). team_lead may edit.
        const rdOk = await put(baseUrl, RD_PATH, {
          defaultPrimaryUserId: CEO_ID,
          defaultCheckerUserId: CEO_ID,
        });
        assert.equal(rdOk.status, 200, `J: valid role-defaults PUT must be 200 (got ${rdOk.status}: ${JSON.stringify(rdOk.body)})`);
        assert.equal(rdOk.body?.department?.defaultPrimaryUserId, CEO_ID, "J: defaultPrimaryUserId saved");
        assert.equal(rdOk.body?.department?.defaultCheckerUserId, CEO_ID, "J: defaultCheckerUserId saved");
        assert.equal(
          Object.prototype.hasOwnProperty.call(rdOk.body?.department ?? {}, "defaultSupervisorUserId"),
          false,
          "J: role-default responses omit the retired Supervisor default",
        );

        // Audit trail (same mechanism as bulk assign).
        const rdAudit = await db.execute(sql`
          SELECT * FROM admin_setting_audit
          WHERE setting_key = 'sd_department_role_defaults' AND scope = ${DEPT_ID}
          ORDER BY changed_at DESC
          LIMIT 1
        `);
        const rdAuditRow = (rdAudit as any).rows[0];
        assert.ok(rdAuditRow, "J: role-defaults change must write an admin_setting_audit row");
        assert.equal(rdAuditRow.changed_by, LEAD_ID, "J: audit changedBy = acting team lead");
        assert.equal(rdAuditRow.new_values?.defaultCheckerUserId, CEO_ID, "J: audit newValues records the checker");

        // Partial update leaves other fields untouched.
        const rdPartial = await put(baseUrl, RD_PATH, { defaultCheckerUserId: null });
        assert.equal(rdPartial.status, 200, "J: partial clear must be 200");
        assert.equal(rdPartial.body?.department?.defaultCheckerUserId, null, "J: checker cleared");
        assert.equal(rdPartial.body?.department?.defaultPrimaryUserId, CEO_ID, "J: primary untouched by partial update");

        console.log("  ✓ J: role-defaults rejects Supervisor without state change and preserves Doer/Checker updates");

        // ────────────────────────────────────────────────────────────────
        // (K) Task #4171 — removing a member also clears department-level
        //     default slots and reports clearedDepartmentSlots.
        //     State: supported dept defaults primary=CEO, checker=null.
        // ────────────────────────────────────────────────────────────────
        // Give CEO a client-assignment slot too so BOTH kinds of clearing
        // show up in one response.
        activeUserId = LEAD_ID;
        const ceoAssign = await put(
          baseUrl,
          `/api/service-desk/clients/${CLIENT_ID}/assignments/${DEPT_ID}`,
          { primaryUserId: CEO_ID, checkerUserId: null },
        );
        assert.equal(ceoAssign.status, 200, `K: seeding CEO assignment must be 200 (got ${ceoAssign.status})`);

        activeUserId = CEO_ID;
        const membersResp2 = await get(baseUrl, `/api/service-desk/departments/${DEPT_ID}/members`);
        const ceoMemberRow = (membersResp2.body.members as any[]).find((m) => m.userId === CEO_ID && m.active);
        assert.ok(ceoMemberRow, "K: CEO member row must exist");

        const del = await fetch(`${baseUrl}/api/service-desk/departments/${DEPT_ID}/members/${ceoMemberRow.id}`, {
          method: "DELETE",
        });
        const delBody: any = await del.json();
        assert.equal(del.status, 200, `K: DELETE member must be 200 (got ${del.status}: ${JSON.stringify(delBody)})`);
        assert.ok(
          delBody?.clearedDepartmentSlots,
          `K: DELETE response must include clearedDepartmentSlots (got ${JSON.stringify(delBody)})`,
        );
        assert.equal(delBody.clearedDepartmentSlots.clearedPrimary, true, "K: dept default primary cleared");
        assert.equal(delBody.clearedDepartmentSlots.clearedChecker, false, "K: dept checker slot was already empty");
        assert.ok(
          (delBody.clearedAssignments as any[]).some(
            (c) => c.clientId === CLIENT_ID && c.clearedPrimary,
          ),
          `K: client assignment slots must be cleared too (got ${JSON.stringify(delBody.clearedAssignments)})`,
        );

        const deptAfter = await db.execute(sql`
          SELECT default_primary_user_id, default_checker_user_id
          FROM sd_departments WHERE id = ${DEPT_ID}
        `);
        const deptAfterRow = (deptAfter as any).rows[0];
        assert.equal(deptAfterRow.default_primary_user_id, null, "K: dept default primary column is null");

        console.log("  ✓ K: member removal clears department-level slots + reports clearedDepartmentSlots (Task #4171)");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  await getGlobalDispatcher().close();

  console.log("sd-client-dept-assignments-route: all sections passed (Task #3585).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("sd-client-dept-assignments-route: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
