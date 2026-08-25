/* test-registration
{
  "name": "Service Desk submit status fallback — missing 'submitted' omits status + mirrors actual + CEO alert; has 'submitted' → unchanged; CRTSK_001 → friendly error (Task #3569); Doer/Checker checklist step assignees + richer intake questions (Task #5235)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3569: submit route status-fallback guard. Missing \"submitted\" → createTask called without status (omitted), mirror stores actual ClickUp-assigned status, CEO alert fires with dedupeKey sd_status_drift_<listId>. Has \"submitted\" → unchanged (status: \"submitted\", no alert). CRTSK_001 → friendly plain-English 500, no mirror row. ClickUp + notifyUser stubbed; DB in runInIsolatedSchema.",
  "extraNodeArgs": [
    "--import",
    "./tests/sd-submit-status-fallback-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3569 — Service Desk submit: "submitted" status fallback.
 *
 * Verifies three contracts introduced to fix the CRTSK_001 "Status not found"
 * error when the ClickUp list has no "submitted" status:
 *
 *   (A) List missing "submitted" → createTask called WITH the list's best
 *       intake status (the "open"-type status, else lowest orderindex), mirror
 *       row stores the actual status ClickUp assigned, a deduped CEO admin
 *       alert is fired, and the response carries statusFallbackUsed + a
 *       user-facing statusNotice.
 *
 *   (B) List has "submitted" → createTask called WITH status: "submitted",
 *       mirror row stores "submitted", no admin alert fired, no fallback flag.
 *
 *   (C) createTask throws a CRTSK_001 raw JSON error → HTTP 500 with a
 *       plain-English friendly message (not the raw JSON), no mirror row
 *       written.
 *
 *   (D) getList itself throws → createTask called WITHOUT status (list
 *       default; never risks CRTSK_001), deduped CEO alert fired with the
 *       sd_status_lookup_failed_<listId> key, response carries the fallback
 *       notice.
 *
 * The ClickUp API, ClickUp integration token, and notifyUser are all stubbed
 * via a resolve-hook loader (sd-submit-status-fallback-loader.mjs) so no
 * real network calls escape the suite. DB work runs inside runInIsolatedSchema
 * with pinGetDbForCrossAsync so the Express handlers read the cloned tables.
 *
 * Run with:
 *   NODE_ENV=test npx tsx --import ./tests/sd-submit-status-fallback-setup.mjs \
 *     tests/service-desk-submit-status-fallback.test.ts
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
  sdListMapping,
  sdDepartments,
  sdRequestTypes,
  sdTicketMapping,
  clickupTasks,
} from "@shared/schema";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// ─── Constants ────────────────────────────────────────────────────────────────

const RUN = Math.random().toString(36).slice(2, 10);
const ACTOR_ID = "test-3569-actor";
const CEO_ID = `test-3569-ceo-${RUN}`;
const LIST_ID = `list-3569-${RUN}`;
const DEPT_ID = PAID_SEARCH_DEPARTMENT_ID;
const RT_ID = `rt-3569-${RUN}`;
const CF_DEPT = `cf-dept-3569-${RUN}`;
const CF_RT = `cf-rt-3569-${RUN}`;
const CF_REQ = `cf-req-3569-${RUN}`;
const OPT_DEPT = `opt-dept-${RUN}`;
const OPT_RT = `opt-rt-${RUN}`;
const RT_NAME = `Website Change ${RUN}`;

const TABLES = [
  "users",
  "sd_list_mapping",
  "sd_departments",
  "sd_request_types",
  "sd_request_type_questions",
  "sd_request_type_checklist_steps",
  "clickup_tasks",
  "sd_ticket_mapping",
  "sd_ticket_events",
  "clickup_user_tokens",
  "clients",
  "sd_client_dept_assignments",
] as const;

// ─── App factory ──────────────────────────────────────────────────────────────

let activeUserId: string | null = ACTOR_ID;

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

async function postSubmit(
  baseUrl: string,
  overrides: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append("title", `Test Request ${RUN}`);
  form.append("departmentId", DEPT_ID);
  form.append("requestTypeId", RT_ID);
  for (const [k, v] of Object.entries(overrides)) {
    form.append(k, v);
  }
  const r = await fetch(`${baseUrl}/api/service-desk/tickets/submit`, {
    method: "POST",
    body: form,
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

function resetStubs(overrides: {
  getListResult?: object;
  getListError?: Error;
  createTaskResult?: object;
  createTaskError?: Error;
}) {
  (globalThis as any).__sdSubmitGetListResult = overrides.getListResult ?? undefined;
  (globalThis as any).__sdSubmitGetListError = overrides.getListError ?? undefined;
  (globalThis as any).__sdSubmitCreateTaskResult = overrides.createTaskResult ?? undefined;
  (globalThis as any).__sdSubmitCreateTaskError = overrides.createTaskError ?? undefined;
  (globalThis as any).__sdSubmitCreateTaskCalls = [];
  (globalThis as any).__sdSubmitNotifyCalls = [];
  (globalThis as any).__sdSubmitSetFieldCalls = [];
  (globalThis as any).__sdSubmitUpdateTaskCalls = [];
}

function updateTaskCalls(): Array<{ taskId: string; body: any }> {
  return (globalThis as any).__sdSubmitUpdateTaskCalls ?? [];
}

function setFieldCalls(): Array<{ taskId: string; fieldId: string; value: any }> {
  return (globalThis as any).__sdSubmitSetFieldCalls ?? [];
}

function createTaskCalls(): Array<{ body: any }> {
  return (globalThis as any).__sdSubmitCreateTaskCalls ?? [];
}

function notifyCalls(): Array<{ userId: string; params: any }> {
  return (globalThis as any).__sdSubmitNotifyCalls ?? [];
}

async function waitForNotify(minCalls: number, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (notifyCalls().length >= minCalls) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Every submit in this suite also legitimately fires the Task #3585
// "no assignee" coverage alert (sd_no_assignee_*) because no client×dept
// assignment is seeded, and its fire-and-forget timing can land it before
// the status alert under test. Wait for and match the wanted alert by
// dedupeKey prefix instead of taking the first CEO call (same principle as
// B3's sd_status_ prefix filter).
async function waitForCeoAlert(
  ceoId: string,
  dedupePrefix: string,
  timeoutMs = 500,
): Promise<{ userId: string; params: any } | undefined> {
  const match = () =>
    notifyCalls().find(
      (c) =>
        c.userId === ceoId &&
        String(c.params?.dedupeKey ?? "").startsWith(dedupePrefix),
    );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !match()) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return match();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed: actor + CEO ──────────────────────────────────────────────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name, email)
        VALUES (${ACTOR_ID}, 'account_manager', 'Actor 3569', 'actor-3569@test.example')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${CEO_ID}, 'ceo', 'CEO 3569')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);

      // Pre-register the acting users so requireAuth resolves them from the
      // sandbox seed instead of JIT-provisioning a public-schema row.
      __test_markUserReconciled(ACTOR_ID, {
        id: ACTOR_ID,
        role: "account_manager",
        firstName: "Actor 3569",
        email: "actor-3569@test.example",
      });
      __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo", firstName: "CEO 3569" });

      // ── Seed: list mapping with all required fields + option maps ─────
      await db.insert(sdListMapping).values({
        clickupListId: LIST_ID,
        fieldDepartmentId: CF_DEPT,
        fieldRequestTypeId: CF_RT,
        fieldRequesterId: CF_REQ,
        clickupWorkspaceId: "ws-3569",
        departmentOptionIds: { [OPT_DEPT]: DEPT_ID },
        requestTypeOptionIds: { [OPT_RT]: RT_NAME },
        setupStep: "complete",
      });

      // ── Seed: department + request type ───────────────────────────────
      await db.insert(sdDepartments).values({ id: DEPT_ID, name: "Paid Search", sortOrder: 0 });
      await db.insert(sdRequestTypes).values({ id: RT_ID, name: RT_NAME, isActive: true });

      // Workspace member roster used by the requester People-field resolution
      // (actor has no clickup_user_tokens row here, so the route falls back to
      // an email match against getWorkspaceMembers).
      (globalThis as any).__sdSubmitWorkspaceMembers = [
        { user: { id: 90577, email: "actor-3569@test.example" } },
      ];

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (A) List is missing "submitted" status ─────────────────────
        // getList returns no "submitted" → createTask must use the list's
        // "open"-type status ("todo"), mirror stores actual returned status,
        // CEO alert fires once, response carries the fallback notice.
        resetStubs({
          getListResult: {
            statuses: [
              { status: "in progress", type: "custom", orderindex: 1 },
              { status: "todo", type: "open", orderindex: 0 },
            ],
          },
          createTaskResult: {
            id: `task-A-${RUN}`,
            url: `https://app.clickup.com/t/task-A-${RUN}`,
            status: { status: "todo" },
          },
        });

        activeUserId = ACTOR_ID;
        const respA = await postSubmit(baseUrl);
        assert.equal(
          respA.status,
          200,
          `(A) expected 200 (got ${respA.status}: ${JSON.stringify(respA.body)})`,
        );
        assert.ok(respA.body?.success, "(A) body.success must be true");
        assert.equal(respA.body?.taskId, `task-A-${RUN}`, "(A) taskId must match stub");

        // createTask was called with the list's open-type status
        const callsA = createTaskCalls();
        assert.equal(callsA.length, 1, "(A) createTask must be called exactly once");
        assert.equal(
          callsA[0].body.status,
          "todo",
          `(A) createTask payload must use the list's open-type status "todo" (got ${JSON.stringify(callsA[0].body.status)})`,
        );
        console.log("  ✓ A1: list missing 'submitted' → createTask uses the list's open-type status");

        // Response carries the user-facing fallback notice
        assert.equal(respA.body?.statusFallbackUsed, true, "(A) response must set statusFallbackUsed");
        assert.ok(
          typeof respA.body?.statusNotice === "string" && respA.body.statusNotice.includes("todo"),
          `(A) response statusNotice must mention the actual status (got: ${JSON.stringify(respA.body?.statusNotice)})`,
        );
        console.log("  ✓ A1b: response carries statusFallbackUsed + statusNotice");

        // Mirror row stores actual task status ("todo"), not "submitted"
        await waitForNotify(1); // give async fire-and-forget time to run
        const mirrorA = await db.execute(sql`
          SELECT status FROM clickup_tasks WHERE id = ${`task-A-${RUN}`} LIMIT 1
        `);
        assert.equal(mirrorA.rows.length, 1, "(A) clickup_tasks mirror row must exist");
        assert.equal(
          mirrorA.rows[0].status,
          "todo",
          `(A) mirror status must be "todo" (got "${mirrorA.rows[0].status}")`,
        );
        console.log("  ✓ A2: mirror row stores actual ClickUp-assigned status");

        // Admin alert was fired for CEO — matched by prefix because the
        // sd_no_assignee_* alert can arrive first (see waitForCeoAlert).
        const ceoAlert = await waitForCeoAlert(CEO_ID, "sd_status_drift_");
        assert.ok(ceoAlert, `(A) notifyUser must be called for CEO ${CEO_ID} with an sd_status_drift_* key (calls: ${JSON.stringify(notifyCalls().map((c) => c.params?.dedupeKey ?? c.userId))})`);
        assert.equal(
          ceoAlert!.params.dedupeKey,
          `sd_status_drift_${LIST_ID}`,
          `(A) dedupeKey must be sd_status_drift_<listId> (got "${ceoAlert!.params.dedupeKey}")`,
        );
        console.log("  ✓ A3: deduped CEO alert fired with correct dedupeKey");

        // ── (B) List HAS "submitted" status ───────────────────────────
        // getList returns "submitted" → createTask must include status: "submitted",
        // mirror stores "submitted", no admin alert.
        resetStubs({
          getListResult: { statuses: [{ status: "submitted" }, { status: "todo" }] },
          createTaskResult: {
            id: `task-B-${RUN}`,
            url: `https://app.clickup.com/t/task-B-${RUN}`,
            status: { status: "submitted" },
          },
        });

        const respB = await postSubmit(baseUrl);
        assert.equal(
          respB.status,
          200,
          `(B) expected 200 (got ${respB.status}: ${JSON.stringify(respB.body)})`,
        );

        const callsB = createTaskCalls();
        assert.equal(callsB.length, 1, "(B) createTask must be called exactly once");
        assert.equal(
          callsB[0].body.status,
          "submitted",
          `(B) createTask payload must have status="submitted" (got ${JSON.stringify(callsB[0].body.status)})`,
        );
        console.log("  ✓ B1: list has 'submitted' → createTask called with status='submitted'");

        // Requester is a ClickUp People ("users") field: the create payload must
        // NOT carry the actor's email as a custom field value (ClickUp rejects
        // the whole task with "Invalid Value"); instead the numeric ClickUp user
        // ID (resolved via workspace-member email match) is set post-create via
        // setCustomFieldValue with the documented { add, rem } shape.
        const reqCf = (callsB[0].body.custom_fields ?? []).find((f: any) => f.id === CF_REQ);
        assert.equal(
          reqCf,
          undefined,
          `(B) createTask payload must not include the requester People field (got ${JSON.stringify(reqCf)})`,
        );
        const reqSet = setFieldCalls().find((c) => c.fieldId === CF_REQ);
        assert.ok(reqSet, "(B) setCustomFieldValue must be called for the requester People field");
        assert.equal(reqSet!.taskId, `task-B-${RUN}`, "(B) requester field set on the created task");
        assert.deepEqual(
          reqSet!.value,
          { add: [90577], rem: [] },
          `(B) requester field value must be { add: [clickupUserId], rem: [] } (got ${JSON.stringify(reqSet!.value)})`,
        );
        console.log("  ✓ B1c: requester set post-create as People field { add, rem }, not email-at-create");

        const mirrorB = await db.execute(sql`
          SELECT status FROM clickup_tasks WHERE id = ${`task-B-${RUN}`} LIMIT 1
        `);
        assert.equal(mirrorB.rows.length, 1, "(B) clickup_tasks mirror row must exist");
        assert.equal(
          mirrorB.rows[0].status,
          "submitted",
          `(B) mirror status must be "submitted" (got "${mirrorB.rows[0].status}")`,
        );
        console.log("  ✓ B2: mirror row stores 'submitted' when list has the status");

        // Give the fire-and-forget alert paths time to settle so this check is
        // deterministic (a too-early read would pass vacuously). The submit
        // deliberately has no client×dept assignment seeded, so the separate
        // Task #3585 "no assignee" coverage alert (sd_no_assignee_*)
        // legitimately fires — B only asserts that no STATUS-FALLBACK alert
        // (drift / lookup-failed) fired.
        await waitForNotify(1);
        const notifyB = notifyCalls();
        const statusAlertsB = notifyB.filter((c) =>
          String(c.params?.dedupeKey ?? "").startsWith("sd_status_"),
        );
        assert.equal(
          statusAlertsB.length,
          0,
          `(B) no status-fallback alert may fire when list has 'submitted' (got ${JSON.stringify(statusAlertsB.map((c) => c.params?.dedupeKey))})`,
        );
        console.log("  ✓ B3: no status-fallback admin alert when list has 'submitted'");

        assert.equal(
          respB.body?.statusFallbackUsed,
          undefined,
          "(B) response must NOT set statusFallbackUsed when list has 'submitted'",
        );
        console.log("  ✓ B4: no fallback flag in the response when list has 'submitted'");

        // ── (C) createTask throws CRTSK_001 ───────────────────────────
        // Should return HTTP 500 with a plain-English message, no mirror row.
        const crtskError = new Error(
          'ClickUp API error: {"ECODE":"CRTSK_001","err":"Status not found"}',
        );
        resetStubs({
          getListResult: { statuses: [{ status: "submitted" }] },
          createTaskError: crtskError,
        });

        const respC = await postSubmit(baseUrl);
        assert.equal(
          respC.status,
          500,
          `(C) expected 500 (got ${respC.status}: ${JSON.stringify(respC.body)})`,
        );
        const errMsg: string = respC.body?.error ?? "";
        assert.ok(
          !errMsg.includes("CRTSK_001"),
          `(C) error message must not expose raw ECODE (got: "${errMsg}")`,
        );
        assert.ok(
          errMsg.toLowerCase().includes("missing") || errMsg.toLowerCase().includes("status"),
          `(C) error message must mention missing/status (got: "${errMsg}")`,
        );
        console.log("  ✓ C1: CRTSK_001 error mapped to plain-English message");

        // No mirror row for the failing task
        const taskIdC = createTaskCalls()[0]; // createTask was called once, then threw
        const mirrorC = await db.execute(sql`
          SELECT id FROM clickup_tasks WHERE list_id = ${LIST_ID} ORDER BY date_created DESC LIMIT 5
        `);
        const mirrorIds = mirrorC.rows.map((r: any) => r.id);
        assert.ok(
          !mirrorIds.some((id: string) => !id.startsWith("task-A") && !id.startsWith("task-B")),
          `(C) no additional mirror row must exist after createTask failure (found: ${JSON.stringify(mirrorIds)})`,
        );
        console.log("  ✓ C2: no mirror row written when createTask fails");

        // ── (D) getList itself throws ──────────────────────────────────
        // Status pre-check fails → createTask must omit status (list default,
        // never risks CRTSK_001), CEO alert fires with the lookup-failed key,
        // response carries the fallback notice.
        resetStubs({
          getListError: new Error("ClickUp API error: 500 upstream timeout"),
          createTaskResult: {
            id: `task-D-${RUN}`,
            url: `https://app.clickup.com/t/task-D-${RUN}`,
            status: { status: "backlog" },
          },
        });

        const respD = await postSubmit(baseUrl);
        assert.equal(
          respD.status,
          200,
          `(D) expected 200 (got ${respD.status}: ${JSON.stringify(respD.body)})`,
        );
        const callsD = createTaskCalls();
        assert.equal(callsD.length, 1, "(D) createTask must be called exactly once");
        assert.equal(
          callsD[0].body.status,
          undefined,
          `(D) createTask payload must omit status when the lookup fails (got ${JSON.stringify(callsD[0].body.status)})`,
        );
        console.log("  ✓ D1: getList failure → createTask called without explicit status");

        assert.equal(respD.body?.statusFallbackUsed, true, "(D) response must set statusFallbackUsed");
        assert.ok(
          typeof respD.body?.statusNotice === "string" && respD.body.statusNotice.includes("backlog"),
          `(D) response statusNotice must mention the actual status (got: ${JSON.stringify(respD.body?.statusNotice)})`,
        );
        console.log("  ✓ D2: response carries the fallback notice on lookup failure");

        // Matched by prefix because the sd_no_assignee_* alert can arrive
        // first (see waitForCeoAlert) — this is what broke when Task #3656
        // shipped: the no-assignee alert landed ahead of the lookup alert.
        const lookupAlert = await waitForCeoAlert(CEO_ID, "sd_status_lookup_failed_");
        assert.ok(lookupAlert, `(D) notifyUser must be called for CEO on lookup failure with an sd_status_lookup_failed_* key (calls: ${JSON.stringify(notifyCalls().map((c) => c.params?.dedupeKey ?? c.userId))})`);
        assert.equal(
          lookupAlert!.params.dedupeKey,
          `sd_status_lookup_failed_${LIST_ID}`,
          `(D) dedupeKey must be sd_status_lookup_failed_<listId> (got "${lookupAlert!.params.dedupeKey}")`,
        );
        console.log("  ✓ D3: deduped CEO alert fired with the lookup-failed dedupeKey");

        // Mirror stores the actual ClickUp-assigned status
        const mirrorD = await db.execute(sql`
          SELECT status FROM clickup_tasks WHERE id = ${`task-D-${RUN}`} LIMIT 1
        `);
        assert.equal(mirrorD.rows.length, 1, "(D) clickup_tasks mirror row must exist");
        assert.equal(
          mirrorD.rows[0].status,
          "backlog",
          `(D) mirror status must be "backlog" (got "${mirrorD.rows[0].status}")`,
        );
        console.log("  ✓ D4: mirror row stores actual ClickUp-assigned status on lookup failure");

        // ── (E) Task #5235: Doer owner + Checker watcher ──────────────────
        // Seed a client with its Doer and Checker. createTask must carry only
        // the Doer as owner/assignee; updateTask must add only the Checker as
        // a watcher.
        const CLIENT_E = `client-3618-${RUN}`;
        const DOER_ID = `doer-3618-${RUN}`;
        const CHECKER_ID = `checker-3618-${RUN}`;
        await db.execute(sql`
          INSERT INTO users (id, role, first_name)
          VALUES (${DOER_ID}, 'account_manager', 'Doer'),
                 (${CHECKER_ID}, 'account_manager', 'Checker')
          ON CONFLICT (id) DO NOTHING
        `);
        await db.execute(sql`
          INSERT INTO clients (id, firm_name, is_archived)
          VALUES (${CLIENT_E}, ${'Firm 3618 ' + RUN}, false)
          ON CONFLICT (id) DO NOTHING
        `);
        await db.execute(sql`
          INSERT INTO sd_client_dept_assignments (client_id, department_id, primary_user_id, checker_user_id)
          VALUES (${CLIENT_E}, ${DEPT_ID}, ${DOER_ID}, ${CHECKER_ID})
        `);
        await db.execute(sql`
          INSERT INTO clickup_user_tokens
            (user_id, access_token_encrypted, status, clickup_user_id, workspace_id, authorized_workspaces)
          VALUES (${DOER_ID}, 'tok-doer', 'connected', '70001', 'ws-3569', '[{"id":"ws-3569","name":"Test"}]'::jsonb),
                 (${CHECKER_ID}, 'tok-checker', 'connected', '70002', 'ws-3569', '[{"id":"ws-3569","name":"Test"}]'::jsonb)
          ON CONFLICT DO NOTHING
        `);
        await db.execute(sql`
          INSERT INTO sd_department_members
            (id, department_id, user_id, clickup_user_id, active)
          VALUES
            (${`member-doer-${RUN}`}, ${DEPT_ID}, ${DOER_ID}, '70001', true),
            (${`member-checker-${RUN}`}, ${DEPT_ID}, ${CHECKER_ID}, '70002', true)
          ON CONFLICT DO NOTHING
        `);

        resetStubs({
          getListResult: { statuses: [{ status: "submitted", type: "open", orderindex: 0 }] },
          createTaskResult: {
            id: `task-E-${RUN}`,
            url: `https://app.clickup.com/t/task-E-${RUN}`,
            status: { status: "submitted" },
          },
        });

        const respE = await postSubmit(baseUrl, { clientId: CLIENT_E, clientName: `Firm 3618 ${RUN}` });
        assert.equal(respE.status, 200, `(E) expected 200 (got ${respE.status}: ${JSON.stringify(respE.body)})`);

        const callsE = createTaskCalls();
        assert.equal(callsE.length, 1, "(E) createTask must be called exactly once");
        assert.deepEqual(
          callsE[0].body.assignees,
          ["70001"],
          `(E) createTask assignees must be ONLY the Primary Doer's ClickUp id (got ${JSON.stringify(callsE[0].body.assignees)})`,
        );

        const updE = updateTaskCalls().filter((c) => c.taskId === `task-E-${RUN}` && c.body?.watchers);
        assert.equal(updE.length, 1, `(E) exactly one watcher updateTask call expected (got ${updE.length})`);
        assert.deepEqual(
          updE[0].body.watchers,
          { add: [70002], rem: [] },
          `(E) watcher add must be ONLY the Checker's ClickUp id (got ${JSON.stringify(updE[0].body.watchers)})`,
        );
        console.log("  ✓ E: doer = owner/assignee, checker = watcher (Task #5235)");

        // ── (F) Task #5235: checklist step assignees on the native submit
        // path + richer intake question round-trip (helpText / placeholder /
        // defaultValue / multi_select) through the CRUD routes and the
        // submission endpoint.
        const F_FIX = `fix-3656-${RUN}`;
        const F_GHOST = `ghost-3656-${RUN}`; // no ClickUp identity anywhere
        await db.execute(sql`
          INSERT INTO users (id, role, first_name)
          VALUES (${F_FIX}, 'account_manager', 'Fixed'),
                 (${F_GHOST}, 'account_manager', 'Ghost')
          ON CONFLICT (id) DO NOTHING
        `);
        await db.execute(sql`
          INSERT INTO clickup_user_tokens
            (user_id, access_token_encrypted, status, clickup_user_id, workspace_id, authorized_workspaces)
          VALUES (${F_FIX}, 'tok-fix', 'connected', '70010', 'ws-3569', '[{"id":"ws-3569","name":"Test"}]'::jsonb)
          ON CONFLICT DO NOTHING
        `);
        await db.execute(sql`
          INSERT INTO sd_department_members
            (id, department_id, user_id, clickup_user_id, active)
          VALUES (${`member-fixed-${RUN}`}, ${DEPT_ID}, ${F_FIX}, '70010', true)
          ON CONFLICT DO NOTHING
        `);

        // Question + step CRUD as CEO: create richer questions and steps with
        // assignees; assert the routes echo (and later list) the new fields.
        activeUserId = CEO_ID;
        const jpost = async (path: string, payload: any) => {
          const r = await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          return { status: r.status, body: await r.json().catch(() => null) };
        };
        const jput = async (path: string, payload: any) => {
          const r = await fetch(`${baseUrl}${path}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          return { status: r.status, body: await r.json().catch(() => null) };
        };

        const qMulti = await jpost(`/api/service-desk/request-types/${RT_ID}/questions`, {
          label: `Channels ${RUN}`,
          questionType: "multi_select",
          required: false,
          sortOrder: 1,
          options: ["Email", "Phone", "Slack"],
          helpText: "Pick every channel that applies",
          placeholder: "n/a",
          defaultValue: "Email",
        });
        assert.equal(qMulti.status, 200, `(F) multi_select question create must 200 (got ${qMulti.status}: ${JSON.stringify(qMulti.body)})`);
        assert.equal(qMulti.body.question.questionType, "multi_select", "(F) type stored");
        assert.deepEqual(qMulti.body.question.options, ["Email", "Phone", "Slack"], "(F) options stored for multi_select");
        assert.equal(qMulti.body.question.helpText, "Pick every channel that applies", "(F) helpText stored");
        assert.equal(qMulti.body.question.defaultValue, "Email", "(F) defaultValue stored");

        const qBadType = await jpost(`/api/service-desk/request-types/${RT_ID}/questions`, {
          label: "Bad", questionType: "made_up",
        });
        assert.equal(qBadType.status, 400, "(F) unknown questionType rejected with 400");

        const qEdit = await jput(
          `/api/service-desk/request-types/${RT_ID}/questions/${qMulti.body.question.id}`,
          { placeholder: "  ", helpText: "Updated help" },
        );
        assert.equal(qEdit.status, 200, "(F) question PUT must 200");
        assert.equal(qEdit.body.question.placeholder, null, "(F) blank placeholder normalizes to null");
        assert.equal(qEdit.body.question.helpText, "Updated help", "(F) helpText updated");
        assert.equal(qEdit.body.question.sortOrder, 1, "(F) editing preserves sortOrder");
        assert.deepEqual(qEdit.body.question.options, ["Email", "Phone", "Slack"], "(F) editing preserves options");
        console.log("  ✓ F1: richer question fields + multi_select round-trip through CRUD (Task #5235)");

        // Steps: fixed user, plus dynamic Doer and Checker roles for the
        // ticket's client and department.
        const mkStep = (payload: any) =>
          jpost(`/api/service-desk/request-types/${RT_ID}/checklist-steps`, payload);
        // A second department whose doer differs from the ticket department's —
        // used by the per-step department override.
        const DEPT2_ID = `dept2-3656-${RUN}`;
        await db.execute(sql`
          INSERT INTO sd_departments (id, name, sort_order) VALUES (${DEPT2_ID}, ${'Dept2 ' + RUN}, 1)
        `);
        await db.execute(sql`
          INSERT INTO sd_client_dept_assignments (client_id, department_id, primary_user_id)
          VALUES (${CLIENT_E}, ${DEPT2_ID}, ${F_FIX})
        `);
        await db.execute(sql`
          INSERT INTO sd_department_members
            (id, department_id, user_id, clickup_user_id, active)
          VALUES (${`member-fixed-dept2-${RUN}`}, ${DEPT2_ID}, ${F_FIX}, '70010', true)
        `);

        const sFixed = await mkStep({ name: "F fixed", sortOrder: 1, assigneeUserId: F_FIX });
        const sDoer = await mkStep({ name: "F doer", sortOrder: 2, assigneeRole: "doer" });
        const sChecker = await mkStep({ name: "F checker", sortOrder: 3, assigneeRole: "checker" });
        const sGhost = await mkStep({ name: "F ghost", sortOrder: 4, assigneeUserId: F_GHOST });
        const sPlain = await mkStep({ name: "F plain", sortOrder: 5 });
        const sXDept = await mkStep({ name: "F xdept doer", sortOrder: 6, assigneeRole: "doer", assigneeDepartmentId: DEPT2_ID });
        for (const [label, r] of [["fixed", sFixed], ["doer", sDoer], ["checker", sChecker], ["ghost", sGhost], ["plain", sPlain], ["xdept", sXDept]] as const) {
          assert.equal(r.status, 200, `(F) ${label} step create must 200 (got ${r.status}: ${JSON.stringify(r.body)})`);
        }
        assert.equal(sDoer.body.step.assigneeRole, "doer", "(F) role stored on step");
        assert.equal(sXDept.body.step.assigneeDepartmentId, DEPT2_ID, "(F) department override stored on step");
        const sBoth = await mkStep({ name: "F both", assigneeUserId: F_FIX, assigneeRole: "doer" });
        assert.equal(sBoth.status, 400, "(F) both assigneeUserId and assigneeRole rejected");
        const sBadRole = await mkStep({ name: "F bad role", assigneeRole: "boss" });
        assert.equal(sBadRole.status, 400, "(F) unknown role token rejected");
        const sDeptNoRole = await mkStep({ name: "F dept no role", assigneeUserId: F_FIX, assigneeDepartmentId: DEPT2_ID });
        assert.equal(sDeptNoRole.status, 400, "(F) department override without a dynamic role rejected");
        console.log("  ✓ F2: step assignee CRUD validation (fixed/role/dept-override stored; invalid combos rejected)");

        // Submit as the actor with answers incl. the multi_select value.
        activeUserId = ACTOR_ID;
        resetStubs({
          getListResult: { statuses: [{ status: "submitted", type: "open", orderindex: 0 }] },
          createTaskResult: {
            id: `task-F-${RUN}`,
            url: `https://app.clickup.com/t/task-F-${RUN}`,
            status: { status: "submitted" },
          },
        });
        (globalThis as any).__sdSubmitCreateChecklistCalls = [];
        (globalThis as any).__sdSubmitCreateChecklistItemCalls = [];

        const respF = await postSubmit(baseUrl, {
          clientId: CLIENT_E,
          clientName: `Firm 3618 ${RUN}`,
          answers: JSON.stringify([
            { questionId: qMulti.body.question.id, value: "Email, Slack" },
          ]),
        });
        assert.equal(respF.status, 200, `(F) expected 200 (got ${respF.status}: ${JSON.stringify(respF.body)})`);

        const checklistCallsF = (globalThis as any).__sdSubmitCreateChecklistCalls as Array<{ taskId: string; name: string }>;
        assert.equal(checklistCallsF.length, 1, "(F) one checklist created on submit");
        assert.equal(checklistCallsF[0].taskId, `task-F-${RUN}`, "(F) checklist on the created task");
        const itemsF = (globalThis as any).__sdSubmitCreateChecklistItemCalls as Array<{ body: { name: string; assignee?: number } }>;
        assert.deepEqual(
          itemsF.map((i) => i.body.name),
          ["F fixed", "F doer", "F checker", "F ghost", "F plain", "F xdept doer"],
          "(F) all steps posted in sort order",
        );
        assert.deepEqual(
          itemsF.map((i) => i.body.assignee),
          [70010, 70001, 70002, undefined, undefined, 70010],
          `(F) fixed→own ClickUp id, doer/checker→ticket department roles, ghost + plain → unassigned, dept-override doer→Dept2's doer (got ${JSON.stringify(itemsF.map((i) => i.body.assignee))})`,
        );
        console.log("  ✓ F3: submit path resolves fixed, Doer, and Checker step assignees");

        const mappingF = await db.execute(sql`
          SELECT question_answers FROM sd_ticket_mapping WHERE clickup_task_id = ${`task-F-${RUN}`} LIMIT 1
        `);
        assert.equal(mappingF.rows.length, 1, "(F) ticket mapping row exists");
        const answersF = mappingF.rows[0].question_answers as Array<{ label: string; value: string }>;
        const chan = (answersF ?? []).find((a) => a.label === `Channels ${RUN}`);
        assert.ok(chan, `(F) stored answers must include the multi_select question (got ${JSON.stringify(answersF)})`);
        assert.equal(chan!.value, "Email, Slack", "(F) multi_select answer stored as the joined string");
        console.log("  ✓ F4: multi_select answer stored in the structured question_answers format");

        console.log("\nservice-desk-submit-status-fallback: all assertions passed");
      } finally {
        server.close();
        __test_resetReconciledUsers();
        getGlobalDispatcher().close?.();
      }
    },
    { tables: TABLES, pinGetDbForCrossAsync: true },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
