/* test-registration
{
  "name": "Service Desk department hard delete — CEO gate, inactive-first guard, exact cascade + audit, option-map surgery (Task #4892)",
  "regression": true,
  "sweepOnlyReason": "Task #4892 — department hard-delete endpoint: DB-heavy (runInIsolatedSchema: users, clients, sd_* tables, admin_setting_audit) + real HTTP server; not a smoke-gate candidate.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4892 — Service Desk department permanent delete:
 *
 *   GET    /api/service-desk/departments/:id/delete-impact
 *   DELETE /api/service-desk/departments/:id   (repurposed soft-deactivate → hard delete)
 *
 * Sections:
 *   (A) Auth gates: unauthenticated DELETE → 401; team_lead DELETE and
 *       delete-impact GET → 403 (CEO-only)
 *   (B) Inactive-first guard: DELETE on an ACTIVE department → 409, nothing
 *       deleted; delete-impact reports deletable=false
 *   (C) Impact preview on an inactive department: exact counts + ClickUp
 *       option ids + projection artifacts; unknown id → 404
 *   (D) Successful delete: cascade counts in the response match the preview;
 *       department + members + per-client assignments + dept-scoped request
 *       types (questions, checklist steps) deleted; surviving checklist-step
 *       department overrides NULLed (step kept); ticket mapping rows kept
 *       with department_id NULLed; option-map entry removed (other entries
 *       kept, request-type map untouched); other department + global request
 *       type fully untouched; historical ticket events remain; projection
 *       commands/targets/destinations are removed; admin_setting_audit row
 *       records actor + counts
 *   (E) Concurrent and repeated delete are safe: one success, remaining
 *       attempts and post-delete preview → 404
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
  sdDepartments,
  sdDepartmentMembers,
  sdRequestTypes,
  sdRequestTypeQuestions,
  sdRequestTypeChecklistSteps,
  sdTicketMapping,
} from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const RUN = Math.random().toString(36).slice(2, 8);
const CEO_ID = `test-4892-ceo-${RUN}`;
const LEAD_ID = `test-4892-lead-${RUN}`;
const MEMBER_ID = `test-4892-member-${RUN}`;
const CLIENT_A = `test-4892-client-a-${RUN}`;
const DEPT_DEAD = `dept-4892-dead-${RUN}`;
const DEPT_OTHER = `dept-4892-other-${RUN}`;
const RT_DEAD = `rt-4892-dead-${RUN}`;
const RT_GLOBAL = `rt-4892-global-${RUN}`;
const RT_OTHER = `rt-4892-other-${RUN}`;
const STEP_GLOBAL_OVERRIDE = `step-4892-global-${RUN}`;
const STEP_OTHER = `step-4892-other-${RUN}`;
const TICKET_DEAD = `task-4892-dead-${RUN}`;
const TICKET_OTHER = `task-4892-other-${RUN}`;
const OPT_DEAD = `opt-4892-dead-${RUN}`;
const OPT_OTHER = `opt-4892-other-${RUN}`;
const PROJECTION_DEST_DEAD = `proj-4892-dead-${RUN}`;
const PROJECTION_DEST_OTHER = `proj-4892-other-${RUN}`;

const TABLES = [
  "users",
  "clients",
  "sd_list_mapping",
  "sd_departments",
  "sd_department_members",
  "sd_client_dept_assignments",
  "sd_request_types",
  "sd_request_type_questions",
  "sd_request_type_checklist_steps",
  "sd_ticket_mapping",
  "sd_ticket_events",
  "cu_role_projection_destinations",
  "cu_role_projection_client_targets",
  "cu_role_projection_commands",
  "admin_setting_audit",
] as const;

let activeUserId: string | null = CEO_ID;

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

const deletePath = (id: string) => `/api/service-desk/departments/${id}`;
const impactPath = (id: string) => `/api/service-desk/departments/${id}/delete-impact`;

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed ───────────────────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES
          (${CEO_ID}, 'ceo', 'Ceo 4892'),
          (${LEAD_ID}, 'team_lead', 'Lead 4892'),
          (${MEMBER_ID}, 'account_manager', 'Member 4892')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "Ceo 4892" });
      __test_markUserReconciled(LEAD_ID, { id: LEAD_ID, role: "team_lead", firstName: "Lead 4892" });

      await db.execute(sql`
        INSERT INTO clients (id, firm_name, is_archived)
        VALUES (${CLIENT_A}, 'Firm A 4892', false)
        ON CONFLICT (id) DO UPDATE SET firm_name = EXCLUDED.firm_name
      `);

      // Target department starts ACTIVE (for the 409 guard), survivor stays active.
      await db.insert(sdDepartments).values([
        { id: DEPT_DEAD, name: `Doomed 4892 ${RUN}`, active: true, sortOrder: 1 },
        { id: DEPT_OTHER, name: `Survivor 4892 ${RUN}`, active: true, sortOrder: 2 },
      ]).onConflictDoNothing();

      // MEMBER belongs to BOTH departments — only the doomed row may go.
      await db.insert(sdDepartmentMembers).values([
        { departmentId: DEPT_DEAD, userId: MEMBER_ID, active: true },
        { departmentId: DEPT_OTHER, userId: MEMBER_ID, active: true },
      ]).onConflictDoNothing();

      // Per-client assignment rows for both departments.
      await db.execute(sql`
        INSERT INTO sd_client_dept_assignments (client_id, department_id, primary_user_id)
        VALUES
          (${CLIENT_A}, ${DEPT_DEAD}, ${MEMBER_ID}),
          (${CLIENT_A}, ${DEPT_OTHER}, ${MEMBER_ID})
      `);

      // Request types: one scoped to the doomed dept (1 question + 2 steps),
      // one GLOBAL with a step whose department override points at the doomed
      // dept (override must be NULLed, step kept), one scoped to the survivor
      // (question + override step untouched).
      await db.insert(sdRequestTypes).values([
        { id: RT_DEAD, departmentId: DEPT_DEAD, name: `Doomed RT 4892 ${RUN}`, active: true, sortOrder: 1 },
        { id: RT_GLOBAL, departmentId: null, name: `Global RT 4892 ${RUN}`, active: true, sortOrder: 2 },
        { id: RT_OTHER, departmentId: DEPT_OTHER, name: `Survivor RT 4892 ${RUN}`, active: true, sortOrder: 3 },
      ]).onConflictDoNothing();
      await db.insert(sdRequestTypeQuestions).values([
        { requestTypeId: RT_DEAD, label: `Doomed Q 4892 ${RUN}`, questionType: "text", sortOrder: 0 },
        { requestTypeId: RT_GLOBAL, label: `Global Q 4892 ${RUN}`, questionType: "text", sortOrder: 0 },
        { requestTypeId: RT_OTHER, label: `Survivor Q 4892 ${RUN}`, questionType: "text", sortOrder: 0 },
      ]);
      await db.insert(sdRequestTypeChecklistSteps).values([
        { requestTypeId: RT_DEAD, name: `Doomed step 1 ${RUN}`, sortOrder: 0 },
        { requestTypeId: RT_DEAD, name: `Doomed step 2 ${RUN}`, sortOrder: 1, assigneeRole: "checker", assigneeDepartmentId: DEPT_DEAD },
        { id: STEP_GLOBAL_OVERRIDE, requestTypeId: RT_GLOBAL, name: `Global step ${RUN}`, sortOrder: 0, assigneeRole: "checker", assigneeDepartmentId: DEPT_DEAD },
        { id: STEP_OTHER, requestTypeId: RT_OTHER, name: `Survivor step ${RUN}`, sortOrder: 0, assigneeRole: "doer", assigneeDepartmentId: DEPT_OTHER },
      ]);

      // Tickets: one tagged with the doomed dept (kept, untagged), one with
      // the survivor (fully untouched).
      await db.insert(sdTicketMapping).values([
        { clickupTaskId: TICKET_DEAD, clientUuid: CLIENT_A, departmentId: DEPT_DEAD, requesterUserId: MEMBER_ID },
        { clickupTaskId: TICKET_OTHER, clientUuid: CLIENT_A, departmentId: DEPT_OTHER, requesterUserId: MEMBER_ID },
      ]).onConflictDoNothing();
      await db.execute(sql`
        INSERT INTO sd_ticket_events (clickup_task_id, event_type, actor_user_id, data)
        VALUES (${TICKET_DEAD}, 'department_change', ${MEMBER_ID}, '{"kept":true}'::jsonb)
      `);

      // Projection artifacts are live configuration and must be deleted with
      // the department. Neighboring artifacts prove the cascade is UUID-scoped.
      await db.execute(sql`
        INSERT INTO cu_role_projection_destinations
          (id, workspace_id, department_id, responsibility, target_kind, list_id,
           people_field_id, max_people, environment, enabled)
        VALUES
          (${PROJECTION_DEST_DEAD}, 'ws-4892', ${DEPT_DEAD}, 'doer', 'client_list_parent',
           'list-4892', 'people-4892', 1, 'sandbox', true),
          (${PROJECTION_DEST_OTHER}, 'ws-4892', ${DEPT_OTHER}, 'doer', 'client_list_parent',
           'list-4892', 'people-4892', 1, 'sandbox', true)
      `);
      await db.execute(sql`
        INSERT INTO cu_role_projection_client_targets (client_id, destination_id, target_id)
        VALUES
          (${CLIENT_A}, ${PROJECTION_DEST_DEAD}, 'task-4892-dead'),
          (${CLIENT_A}, ${PROJECTION_DEST_OTHER}, 'task-4892-other')
      `);
      await db.execute(sql`
        INSERT INTO cu_role_projection_commands
          (client_id, destination_id, desired_user_id, desired_clickup_user_id, revision, status)
        VALUES
          (${CLIENT_A}, ${PROJECTION_DEST_DEAD}, ${MEMBER_ID}, 'cu-4892-dead', 'revision-4892-dead', 'pending'),
          (${CLIENT_A}, ${PROJECTION_DEST_OTHER}, ${MEMBER_ID}, 'cu-4892-other', 'revision-4892-other', 'pending')
      `);

      // Option map singleton: one entry per department + a request-type map
      // that must survive untouched.
      await db.execute(sql`
        INSERT INTO sd_list_mapping (clickup_list_id, department_option_ids, request_type_option_ids)
        VALUES (
          ${`list-4892-${RUN}`},
          ${JSON.stringify({ [OPT_DEAD]: DEPT_DEAD, [OPT_OTHER]: DEPT_OTHER })}::jsonb,
          ${JSON.stringify({ [`rtopt-4892-${RUN}`]: `Global RT 4892 ${RUN}` })}::jsonb
        )
      `);

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      const countRows = async (table: string, where: ReturnType<typeof sql>) => {
        const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM ${sql.raw(table)} WHERE ${where}`);
        return (r as any).rows[0].n as number;
      };

      try {
        // ── (A) auth gates ────────────────────────────────────────────────
        activeUserId = null;
        const anon = await req(baseUrl, "DELETE", deletePath(DEPT_DEAD));
        assert.equal(anon.status, 401, `unauthenticated delete must be 401 (got ${anon.status})`);

        activeUserId = LEAD_ID;
        const leadDelete = await req(baseUrl, "DELETE", deletePath(DEPT_DEAD));
        assert.equal(leadDelete.status, 403, `team_lead delete must be 403 (got ${leadDelete.status})`);
        const leadImpact = await req(baseUrl, "GET", impactPath(DEPT_DEAD));
        assert.equal(leadImpact.status, 403, `team_lead delete-impact must be 403 (got ${leadImpact.status})`);
        console.log("  ✓ A: delete + impact endpoints are CEO-only (401 / 403)");

        // ── (B) inactive-first guard ──────────────────────────────────────
        activeUserId = CEO_ID;
        const activeDelete = await req(baseUrl, "DELETE", deletePath(DEPT_DEAD));
        assert.equal(activeDelete.status, 409, `delete on ACTIVE dept must be 409 (got ${activeDelete.status}: ${JSON.stringify(activeDelete.body)})`);
        assert.ok(
          String(activeDelete.body?.error ?? "").toLowerCase().includes("inactive"),
          "409 error must explain the inactive-first rule",
        );
        assert.equal(
          await countRows("sd_departments", sql`id = ${DEPT_DEAD}`),
          1,
          "B: department must still exist after 409",
        );
        assert.equal(
          await countRows("sd_department_members", sql`department_id = ${DEPT_DEAD}`),
          1,
          "B: member rows must be untouched after 409",
        );
        const activeImpact = await req(baseUrl, "GET", impactPath(DEPT_DEAD));
        assert.equal(activeImpact.status, 200, "B: impact preview on active dept must be 200");
        assert.equal(activeImpact.body?.deletable, false, "B: active dept reports deletable=false");
        console.log("  ✓ B: active department refuses deletion (409, no writes; deletable=false)");

        // ── (C) impact preview on an inactive department ──────────────────
        await db.execute(sql`UPDATE sd_departments SET active = false WHERE id = ${DEPT_DEAD}`);

        const unknownImpact = await req(baseUrl, "GET", impactPath(`nope-${RUN}`));
        assert.equal(unknownImpact.status, 404, "C: unknown dept impact must be 404");

        const impact = await req(baseUrl, "GET", impactPath(DEPT_DEAD));
        assert.equal(impact.status, 200, `C: impact must be 200 (got ${impact.status}: ${JSON.stringify(impact.body)})`);
        assert.equal(impact.body?.deletable, true, "C: inactive dept is deletable");
        assert.equal(impact.body?.department?.name, `Doomed 4892 ${RUN}`, "C: department name echoed");
        assert.deepEqual(
          impact.body?.impact,
          {
            memberRows: 1,
            clientAssignmentRows: 1,
            requestTypes: 1,
            requestTypeQuestions: 1,
            requestTypeChecklistSteps: 2,
            checklistStepOverridesCleared: 1,
            ticketMappingsUntagged: 1,
            optionMapEntriesRemoved: 1,
            projectionCommands: 1,
            projectionClientTargets: 1,
            projectionDestinations: 1,
            clickupOptionIds: [OPT_DEAD],
          },
          `C: impact counts must be exact (got ${JSON.stringify(impact.body?.impact)})`,
        );
        console.log("  ✓ C: impact preview reports the exact cascade + ClickUp option ids");

        // ── (D) successful delete: cascade + audit ────────────────────────
        // A stale CEO settings tab may submit the old option map at the same
        // time as retirement. Whichever transaction wins the lock, the final
        // map must never retain the retired UUID.
        const staleConfigSave = req(baseUrl, "PUT", "/api/service-desk/config", {
          departmentOptionIds: { [OPT_DEAD]: DEPT_DEAD, [OPT_OTHER]: DEPT_OTHER },
        });
        const deleteResults = await Promise.all([
          req(baseUrl, "DELETE", deletePath(DEPT_DEAD)),
          req(baseUrl, "DELETE", deletePath(DEPT_DEAD)),
        ]);
        const configSave = await staleConfigSave;
        const del = deleteResults.find((result) => result.status === 200);
        const concurrentRepeat = deleteResults.find((result) => result.status !== 200);
        assert.ok(del, `D: exactly one concurrent deletion must succeed (${JSON.stringify(deleteResults)})`);
        assert.equal(concurrentRepeat?.status, 404, "D: concurrent repeated deletion must be a safe 404");
        assert.ok(
          configSave.status === 200 || configSave.status === 400,
          `D: racing stale config save must settle safely (got ${configSave.status}: ${JSON.stringify(configSave.body)})`,
        );
        assert.equal(del.status, 200, `D: delete must be 200 (got ${del.status}: ${JSON.stringify(del.body)})`);
        assert.equal(del.body?.success, true, "D: success flag");
        assert.equal(del.body?.deleted?.id, DEPT_DEAD, "D: deleted id echoed");
        assert.equal(del.body?.deleted?.name, `Doomed 4892 ${RUN}`, "D: deleted name echoed");
        assert.ok(del.body?.auditId, "D: response must include auditId");
        assert.deepEqual(
          del.body?.cascade,
          {
            memberRows: 1,
            clientAssignmentRows: 1,
            requestTypes: 1,
            requestTypeQuestions: 1,
            requestTypeChecklistSteps: 2,
            checklistStepOverridesCleared: 1,
            ticketMappingsUntagged: 1,
            optionMapEntriesRemoved: 1,
            projectionCommands: 1,
            projectionClientTargets: 1,
            projectionDestinations: 1,
          },
          `D: cascade counts must match the preview (got ${JSON.stringify(del.body?.cascade)})`,
        );

        // Department gone; survivor intact.
        assert.equal(await countRows("sd_departments", sql`id = ${DEPT_DEAD}`), 0, "D: dept row deleted");
        assert.equal(await countRows("sd_departments", sql`id = ${DEPT_OTHER}`), 1, "D: other dept untouched");

        // Members: doomed row gone, survivor membership kept.
        assert.equal(await countRows("sd_department_members", sql`department_id = ${DEPT_DEAD}`), 0, "D: doomed member rows deleted");
        assert.equal(
          await countRows("sd_department_members", sql`department_id = ${DEPT_OTHER} AND user_id = ${MEMBER_ID}`),
          1,
          "D: survivor membership untouched",
        );

        // Per-client assignments: doomed gone, survivor kept.
        assert.equal(await countRows("sd_client_dept_assignments", sql`department_id = ${DEPT_DEAD}`), 0, "D: doomed assignments deleted");
        assert.equal(await countRows("sd_client_dept_assignments", sql`department_id = ${DEPT_OTHER}`), 1, "D: survivor assignment untouched");

        // Request types: doomed one gone with children; global + survivor kept whole.
        assert.equal(await countRows("sd_request_types", sql`id = ${RT_DEAD}`), 0, "D: dept-scoped RT deleted");
        assert.equal(await countRows("sd_request_type_questions", sql`request_type_id = ${RT_DEAD}`), 0, "D: doomed RT questions deleted");
        assert.equal(await countRows("sd_request_type_checklist_steps", sql`request_type_id = ${RT_DEAD}`), 0, "D: doomed RT steps deleted");
        assert.equal(await countRows("sd_request_types", sql`id = ${RT_GLOBAL}`), 1, "D: global RT kept");
        assert.equal(await countRows("sd_request_type_questions", sql`request_type_id = ${RT_GLOBAL}`), 1, "D: global RT question kept");
        assert.equal(await countRows("sd_request_types", sql`id = ${RT_OTHER}`), 1, "D: survivor RT kept");
        assert.equal(await countRows("sd_request_type_questions", sql`request_type_id = ${RT_OTHER}`), 1, "D: survivor RT question kept");

        // Global RT's step survives with the override NULLed; role preserved.
        const globalStep = await db.execute(sql`
          SELECT assignee_department_id, assignee_role FROM sd_request_type_checklist_steps WHERE id = ${STEP_GLOBAL_OVERRIDE}
        `);
        assert.equal((globalStep as any).rows.length, 1, "D: global RT step kept");
        assert.equal((globalStep as any).rows[0].assignee_department_id, null, "D: global step override NULLed (falls back to ticket dept)");
        assert.equal((globalStep as any).rows[0].assignee_role, "checker", "D: global step role preserved");

        // Survivor RT's step keeps its own-dept override.
        const otherStep = await db.execute(sql`
          SELECT assignee_department_id FROM sd_request_type_checklist_steps WHERE id = ${STEP_OTHER}
        `);
        assert.equal((otherStep as any).rows[0].assignee_department_id, DEPT_OTHER, "D: survivor step override untouched");

        // Tickets: doomed ticket kept but untagged (other fields intact);
        // survivor ticket fully untouched.
        const deadTicket = await db.execute(sql`
          SELECT department_id, client_uuid, requester_user_id FROM sd_ticket_mapping WHERE clickup_task_id = ${TICKET_DEAD}
        `);
        assert.equal((deadTicket as any).rows.length, 1, "D: doomed ticket row kept");
        assert.equal((deadTicket as any).rows[0].department_id, null, "D: doomed ticket untagged");
        assert.equal((deadTicket as any).rows[0].client_uuid, CLIENT_A, "D: doomed ticket client intact");
        assert.equal((deadTicket as any).rows[0].requester_user_id, MEMBER_ID, "D: doomed ticket requester intact");
        const otherTicket = await db.execute(sql`
          SELECT department_id FROM sd_ticket_mapping WHERE clickup_task_id = ${TICKET_OTHER}
        `);
        assert.equal((otherTicket as any).rows[0].department_id, DEPT_OTHER, "D: survivor ticket tag untouched");
        assert.equal(
          await countRows("sd_ticket_events", sql`clickup_task_id = ${TICKET_DEAD}`),
          1,
          "D: historical ticket events are retained",
        );

        // Projection rows are removed only for the retired department.
        assert.equal(await countRows("cu_role_projection_destinations", sql`id = ${PROJECTION_DEST_DEAD}`), 0, "D: doomed projection destination deleted");
        assert.equal(await countRows("cu_role_projection_client_targets", sql`destination_id = ${PROJECTION_DEST_DEAD}`), 0, "D: doomed projection target deleted");
        assert.equal(await countRows("cu_role_projection_commands", sql`destination_id = ${PROJECTION_DEST_DEAD}`), 0, "D: doomed projection command deleted");
        assert.equal(await countRows("cu_role_projection_destinations", sql`id = ${PROJECTION_DEST_OTHER}`), 1, "D: survivor projection destination untouched");
        assert.equal(await countRows("cu_role_projection_client_targets", sql`destination_id = ${PROJECTION_DEST_OTHER}`), 1, "D: survivor projection target untouched");
        assert.equal(await countRows("cu_role_projection_commands", sql`destination_id = ${PROJECTION_DEST_OTHER}`), 1, "D: survivor projection command untouched");

        // Option map: doomed entry removed, survivor + request-type map intact.
        const mapping = await db.execute(sql`
          SELECT department_option_ids, request_type_option_ids FROM sd_list_mapping LIMIT 1
        `);
        const deptMap = (mapping as any).rows[0].department_option_ids as Record<string, string>;
        assert.deepEqual(deptMap, { [OPT_OTHER]: DEPT_OTHER }, `D: only the survivor option entry may remain (got ${JSON.stringify(deptMap)})`);
        const rtMap = (mapping as any).rows[0].request_type_option_ids as Record<string, string>;
        assert.deepEqual(rtMap, { [`rtopt-4892-${RUN}`]: `Global RT 4892 ${RUN}` }, "D: request-type option map untouched");

        // Audit row: actor + cascade counts + department snapshot.
        const audit = await db.execute(sql`
          SELECT * FROM admin_setting_audit WHERE id = ${del.body.auditId}
        `);
        const auditRow = (audit as any).rows[0];
        assert.ok(auditRow, "D: audit row must exist");
        assert.equal(auditRow.setting_key, "sd_department_hard_delete", "D: audit settingKey");
        assert.equal(auditRow.scope, DEPT_DEAD, "D: audit scope = department id");
        assert.equal(auditRow.changed_by, CEO_ID, "D: audit changedBy = acting CEO");
        assert.equal(auditRow.old_values?.name, `Doomed 4892 ${RUN}`, "D: audit oldValues snapshot the department");
        assert.equal(auditRow.new_values?.deleted, true, "D: audit newValues.deleted");
        assert.deepEqual(
          auditRow.new_values?.cascade,
          del.body.cascade,
          "D: audit newValues.cascade must equal the returned counts",
        );
        console.log("  ✓ D: delete cascades exactly, leaves neighbors whole, audits actor + counts");

        // ── (E) repeated delete / post-delete preview → 404 ─────────────────
        const again = await req(baseUrl, "DELETE", deletePath(DEPT_DEAD));
        assert.equal(again.status, 404, `E: second delete must be 404 (got ${again.status})`);
        const goneImpact = await req(baseUrl, "GET", impactPath(DEPT_DEAD));
        assert.equal(goneImpact.status, 404, "E: post-delete impact preview must be 404");
        console.log("  ✓ E: deleted department 404s on re-delete and preview");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  await getGlobalDispatcher().close();

  console.log("sd-department-hard-delete-route: all sections passed (Task #4892).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("sd-department-hard-delete-route: FAILED —", err?.stack ?? err, err?.cause ?? "");
    process.exit(1);
  },
);
