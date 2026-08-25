/* test-registration
{
  "name": "Service-desk template enforcement — checklist steps + needs-info comment on ClickUp sync (Task #3395); Doer/Checker step assignee resolution (Task #5235)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3395: the service-desk template-enforcement block in the same post-apply hook. Guards that a new ClickUp ticket of a templated request type gets (a) a checklist POST per configured step in sort_order and (b) a needs-info comment listing the required template questions (plus the \"needs information\" status transition), that flags gate idempotency, that no-template types make zero API calls, and that NoBull-native tickets never get the needs-info comment. All ClickUp API calls go through a resolve-hook recording stub — no real HTTP; DB work runs in runInIsolatedSchema.",
  "extraNodeArgs": [
    "--import",
    "./tests/sd-template-enforcement-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3395 — Service-desk template enforcement smoke test.
 *
 * When a new service request syncs from ClickUp, the template enforcement
 * block in tryCompleteSdTicketMapping (server/services/clickUpWorkerHandlers)
 * must:
 *   (a) create a checklist on the ticket and POST every configured checklist
 *       step (in sort order) for the resolved request type, then mark
 *       template_checklist_applied;
 *   (b) for tickets NOT submitted via the NoBull form, transition the task to
 *       "needs information" and post a needs-info comment listing every
 *       REQUIRED template question (numbered, in sort order), then mark
 *       needs_info_notified;
 *   (c) skip cleanly — no ClickUp API calls — when no template is configured
 *       for the request type;
 *   (d) never re-fire on a subsequent sync (flags gate idempotency), and never
 *       post the needs-info comment for tickets created via NoBull.
 *
 * The ClickUp API is stubbed via a resolve-hook loader
 * (sd-template-enforcement-loader.mjs → clickup/integration stubs) recording
 * every call to globalThis; run with:
 *   npx tsx --import ./tests/sd-template-enforcement-setup.mjs tests/sd-template-enforcement.test.ts
 *
 * Everything runs inside runInIsolatedSchema so live workers can neither see
 * nor race the seeded rows.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { tryCompleteSdTicketMapping } from "../server/services/clickUpWorkerHandlers";
import { PAID_SEARCH_DEPARTMENT_ID } from "../shared/departmentRoleCapabilities";
import { runInIsolatedSchema } from "./db-sandbox";

const TABLES = [
  "sd_list_mapping",
  "sd_ticket_mapping",
  "sd_request_types",
  "sd_request_type_questions",
  "sd_request_type_checklist_steps",
  "sd_departments",
  "sd_client_dept_assignments",
  "sd_department_members",
  "clickup_user_tokens",
  "users",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

// Per-run random token so repeated runs can never collide even if a
// clone/fallthrough bug ever leaks writes to public.* (see memory note).
const RUN = randomUUID().replace(/-/g, "").slice(0, 8);

const LIST_ID = `sd-list-${RUN}`;
const FIELD_RT = `cf-rt-${RUN}`;
const RT_OPT_TEMPLATED = `opt-rt-templated-${RUN}`;
const RT_OPT_BARE = `opt-rt-bare-${RUN}`;
const RT_NAME_TEMPLATED = `Website Change ${RUN}`;
const RT_NAME_BARE = `Bare Type ${RUN}`;
const RT_ID_TEMPLATED = `rt-templated-${RUN}`;
const RT_ID_BARE = `rt-bare-${RUN}`;
const TOKEN_USER = `cu-user-${RUN}`;

// ── Task #5235: Doer/Checker checklist-step resolution fixtures ─────────────
const FIELD_CLIENT = `cf-client-${RUN}`;
const FIELD_DEPT = `cf-dept-${RUN}`;
const CLIENT_OPT = `opt-client-${RUN}`;
const DEPT_OPT = `opt-dept-${RUN}`;
const CLIENT_ID = `client-${RUN}`;
const DEPT_ID = PAID_SEARCH_DEPARTMENT_ID;
const RT_OPT_ASSIGN = `opt-rt-assign-${RUN}`;
const RT_NAME_ASSIGN = `Assignee Type ${RUN}`;
const RT_ID_ASSIGN = `rt-assign-${RUN}`;
const FIX_USER = `u-fix-${RUN}`; // fixed assignee, ClickUp id via token row
const DOER_USER = `u-doer-${RUN}`; // dynamic doer, ClickUp id via token row
const CHECKER_USER = `u-chk-${RUN}`; // dynamic checker, ClickUp id via dept-member fallback
const OTHER_DEPT_ID = `dept-other-${RUN}`; // per-step department override target
const OTHER_DOER_USER = `u-odoer-${RUN}`; // doer of the OTHER department

type CuLedger = {
  createChecklist: Array<{ token: string; taskId: string; name: string }>;
  createChecklistItem: Array<{ token: string; checklistId: string; body: { name: string } }>;
  createTaskComment: Array<{ token: string; taskId: string; body: { comment_text?: string } }>;
  updateTask: Array<{ token: string; taskId: string; body: any }>;
};

function cuCalls(): CuLedger {
  const g = (globalThis as any).__sdTemplateCuCalls;
  assert.ok(g, "ClickUp stub ledger missing — run with --import ./tests/sd-template-enforcement-setup.mjs");
  return g as CuLedger;
}

function snapshotCounts() {
  const c = cuCalls();
  return {
    checklist: c.createChecklist.length,
    items: c.createChecklistItem.length,
    comments: c.createTaskComment.length,
    updates: c.updateTask.length,
  };
}

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

async function seed(isoDb: IsoDb): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO sd_list_mapping
      (id, clickup_list_id, field_request_type_id, request_type_option_ids,
       setup_step, created_at, updated_at)
    VALUES (
      ${`cfg-${RUN}`}, ${LIST_ID}, ${FIELD_RT},
      ${JSON.stringify({ [RT_OPT_TEMPLATED]: RT_NAME_TEMPLATED, [RT_OPT_BARE]: RT_NAME_BARE, [RT_OPT_ASSIGN]: RT_NAME_ASSIGN })}::jsonb,
      'complete', NOW(), NOW()
    )
  `);
  // Client + department fields for the assignee-resolution scenario (harmless
  // to the earlier scenarios, whose tasks carry neither field).
  await isoDb.execute(sql`
    UPDATE sd_list_mapping SET
      field_client_id = ${FIELD_CLIENT},
      client_option_ids = ${JSON.stringify({ [CLIENT_OPT]: CLIENT_ID })}::jsonb,
      field_department_id = ${FIELD_DEPT},
      department_option_ids = ${JSON.stringify({ [DEPT_OPT]: DEPT_ID })}::jsonb
    WHERE id = ${`cfg-${RUN}`}
  `);
  await isoDb.execute(sql`
    INSERT INTO sd_request_types (id, name, created_at, updated_at)
    VALUES (${RT_ID_TEMPLATED}, ${RT_NAME_TEMPLATED}, NOW(), NOW()),
           (${RT_ID_BARE}, ${RT_NAME_BARE}, NOW(), NOW()),
           (${RT_ID_ASSIGN}, ${RT_NAME_ASSIGN}, NOW(), NOW())
  `);
  // Checklist steps — deliberately seeded out of order to prove sort_order wins.
  await isoDb.execute(sql`
    INSERT INTO sd_request_type_checklist_steps
      (id, request_type_id, name, sort_order, created_at, updated_at)
    VALUES (${`step-b-${RUN}`}, ${RT_ID_TEMPLATED}, ${"Get approval"}, 2, NOW(), NOW()),
           (${`step-a-${RUN}`}, ${RT_ID_TEMPLATED}, ${"Collect assets"}, 1, NOW(), NOW()),
           (${`step-c-${RUN}`}, ${RT_ID_TEMPLATED}, ${"Publish change"}, 3, NOW(), NOW())
  `);
  // Questions: two required (out of order) + one optional (must NOT appear).
  await isoDb.execute(sql`
    INSERT INTO sd_request_type_questions
      (id, request_type_id, label, question_type, required, sort_order, created_at, updated_at)
    VALUES (${`q-2-${RUN}`}, ${RT_ID_TEMPLATED}, ${"Which page needs changing?"}, 'text', true, 2, NOW(), NOW()),
           (${`q-1-${RUN}`}, ${RT_ID_TEMPLATED}, ${"What is the client name?"}, 'text', true, 1, NOW(), NOW()),
           (${`q-3-${RUN}`}, ${RT_ID_TEMPLATED}, ${"Any extra notes?"}, 'long_text', false, 3, NOW(), NOW())
  `);
  // A connected ClickUp token row so the template path can pick an API user.
  await isoDb.execute(sql`
    INSERT INTO clickup_user_tokens
      (id, user_id, access_token_encrypted, status, connected_at, updated_at)
    VALUES (${`tok-${RUN}`}, ${TOKEN_USER}, 'stub-enc', 'connected', NOW(), NOW())
  `);

  // ── Task #5235 fixtures: steps with assignees + role assignment rows ──────
  // Steps: fixed user, dynamic Doer, dynamic Checker (department-member
  // ClickUp-id fallback), and a plain unassigned step.
  await isoDb.execute(sql`
    INSERT INTO sd_request_type_checklist_steps
      (id, request_type_id, name, sort_order, assignee_user_id, assignee_role, created_at, updated_at)
    VALUES
      (${`as-1-${RUN}`}, ${RT_ID_ASSIGN}, ${"Fixed person step"}, 1, ${FIX_USER}, NULL, NOW(), NOW()),
      (${`as-2-${RUN}`}, ${RT_ID_ASSIGN}, ${"Doer step"}, 2, NULL, 'doer', NOW(), NOW()),
      (${`as-3-${RUN}`}, ${RT_ID_ASSIGN}, ${"Checker step"}, 3, NULL, 'checker', NOW(), NOW()),
      (${`as-4-${RUN}`}, ${RT_ID_ASSIGN}, ${"Plain step"}, 4, NULL, NULL, NOW(), NOW())
  `);
  // A step whose dynamic role resolves against a DIFFERENT department than
  // the ticket's own (per-step department override).
  await isoDb.execute(sql`
    INSERT INTO sd_request_type_checklist_steps
      (id, request_type_id, name, sort_order, assignee_user_id, assignee_role, assignee_department_id, created_at, updated_at)
    VALUES (${`as-6-${RUN}`}, ${RT_ID_ASSIGN}, ${"Other-dept doer step"}, 6, NULL, 'doer', ${OTHER_DEPT_ID}, NOW(), NOW())
  `);
  // Department rows: role resolution reads sd_departments for scope +
  // defaults (Task #4171), so the departments must exist in the clone.
  await isoDb.execute(sql`
    INSERT INTO sd_departments (id, name, active, sort_order)
    VALUES (${DEPT_ID}, ${"Paid Search"}, true, 0),
           (${OTHER_DEPT_ID}, ${"Other Dept " + RUN}, true, 1)
  `);
  // Role assignment for the client×department: Doer and Checker.
  await isoDb.execute(sql`
    INSERT INTO sd_client_dept_assignments
      (id, client_id, department_id, primary_user_id, checker_user_id, created_at, updated_at)
    VALUES (${`cda-${RUN}`}, ${CLIENT_ID}, ${DEPT_ID}, ${DOER_USER}, ${CHECKER_USER}, NOW(), NOW()),
           (${`cda-o-${RUN}`}, ${CLIENT_ID}, ${OTHER_DEPT_ID}, ${OTHER_DOER_USER}, NULL, NOW(), NOW())
  `);
  // ClickUp identities: fixed + doer via connected token rows; checker only
  // via the active department-member fallback.
  await isoDb.execute(sql`
    INSERT INTO clickup_user_tokens
      (id, user_id, access_token_encrypted, clickup_user_id, status, connected_at, updated_at)
    VALUES (${`tok-fix-${RUN}`}, ${FIX_USER}, 'stub-enc', '80001', 'connected', NOW(), NOW()),
           (${`tok-doer-${RUN}`}, ${DOER_USER}, 'stub-enc', '80002', 'connected', NOW(), NOW()),
           (${`tok-odoer-${RUN}`}, ${OTHER_DOER_USER}, 'stub-enc', '80004', 'connected', NOW(), NOW())
  `);
  // Active department memberships. A dynamic-role user must be an active
  // member of the department they are assigned in for the boundary to project
  // their ClickUp identity (dynamic roles are membership-gated by design). The
  // checker carries its ClickUp id on the member row itself (durable fallback);
  // the doer and other-dept doer are members with NULL member-row ids, so their
  // ClickUp id comes from the connected token (precedence: token > member id).
  await isoDb.execute(sql`
    INSERT INTO sd_department_members
      (id, department_id, user_id, clickup_user_id, active, created_at, updated_at)
    VALUES (${`dm-chk-${RUN}`}, ${DEPT_ID}, ${CHECKER_USER}, '80003', true, NOW(), NOW()),
           (${`dm-doer-${RUN}`}, ${DEPT_ID}, ${DOER_USER}, NULL, true, NOW(), NOW()),
           (${`dm-odoer-${RUN}`}, ${OTHER_DEPT_ID}, ${OTHER_DOER_USER}, NULL, true, NOW(), NOW())
  `);
}

function makeTask(taskId: string, rtValue: any): any {
  return {
    id: taskId,
    custom_fields: rtValue === undefined ? [] : [{ id: FIELD_RT, value: rtValue }],
  };
}

async function getMappingFlags(isoDb: IsoDb, taskId: string) {
  const res = await isoDb.execute(sql`
    SELECT template_checklist_applied, needs_info_notified, created_via_nobull
    FROM sd_ticket_mapping WHERE clickup_task_id = ${taskId}
  `);
  return res.rows as Array<{
    template_checklist_applied: boolean;
    needs_info_notified: boolean;
    created_via_nobull: boolean;
  }>;
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await seed(isoDb);

      // ── 1. Templated request type → checklist + needs-info comment ─────
      {
        const taskId = `t1-${RUN}`;
        await tryCompleteSdTicketMapping(makeTask(taskId, { id: RT_OPT_TEMPLATED }), LIST_ID);

        const c = cuCalls();
        assert.equal(c.createChecklist.length, 1, "exactly one checklist created");
        assert.equal(c.createChecklist[0].taskId, taskId, "checklist created on the synced task");
        assert.equal(
          c.createChecklist[0].name,
          `${RT_NAME_TEMPLATED} Checklist`,
          "checklist named after the request type",
        );
        assert.equal(c.createChecklist[0].token, `stub-token-for-${TOKEN_USER}`, "uses the connected user's token");

        assert.deepEqual(
          c.createChecklistItem.map((i) => i.body.name),
          ["Collect assets", "Get approval", "Publish change"],
          "every checklist step POSTed, in sort_order",
        );
        const checklistIds = new Set(c.createChecklistItem.map((i) => i.checklistId));
        assert.deepEqual([...checklistIds], ["stub-checklist-1"], "items attached to the created checklist");

        assert.equal(c.updateTask.length, 1, "one status transition");
        assert.deepEqual(
          c.updateTask[0],
          { token: `stub-token-for-${TOKEN_USER}`, taskId, body: { status: "needs information" } },
          "task transitioned to 'needs information'",
        );

        assert.equal(c.createTaskComment.length, 1, "exactly one needs-info comment");
        assert.equal(c.createTaskComment[0].taskId, taskId, "comment posted on the synced task");
        const text = c.createTaskComment[0].body.comment_text ?? "";
        assert.ok(
          text.includes("1. What is the client name?") &&
            text.includes("2. Which page needs changing?"),
          `comment lists required questions numbered in sort_order, got:\n${text}`,
        );
        assert.ok(!text.includes("Any extra notes?"), "optional question NOT included");
        assert.ok(
          text.startsWith("[NoBull] This ticket was submitted outside the NoBull portal."),
          "comment carries the outside-portal preamble",
        );

        const rows = await getMappingFlags(isoDb, taskId);
        assert.equal(rows.length, 1, "mapping row exists");
        assert.equal(rows[0].template_checklist_applied, true, "checklist marked applied");
        assert.equal(rows[0].needs_info_notified, true, "needs-info marked notified");
        ok("1: templated type fires checklist POSTs + needs-info comment with required questions");
      }

      // ── 2. Idempotency: second sync of the same task → zero new calls ──
      {
        const before = snapshotCounts();
        await tryCompleteSdTicketMapping(makeTask(`t1-${RUN}`, { id: RT_OPT_TEMPLATED }), LIST_ID);
        assert.deepEqual(snapshotCounts(), before, "re-sync makes no additional ClickUp calls");
        ok("2: flags gate idempotency — re-sync is silent");
      }

      // ── 3. Skip path: request type with NO template configured ─────────
      {
        const before = snapshotCounts();
        const taskId = `t3-${RUN}`;
        await tryCompleteSdTicketMapping(makeTask(taskId, { id: RT_OPT_BARE }), LIST_ID);
        assert.deepEqual(snapshotCounts(), before, "no ClickUp calls for a type without template");
        const rows = await getMappingFlags(isoDb, taskId);
        assert.equal(rows.length, 1, "mapping row still created");
        assert.equal(
          rows[0].template_checklist_applied,
          true,
          "no-steps type marked applied so it is never rechecked",
        );
        assert.equal(rows[0].needs_info_notified, false, "no required questions → no needs-info");
        ok("3: no template configured → skip, zero API calls");
      }

      // ── 4. Skip path: no request-type field value at all ────────────────
      {
        const before = snapshotCounts();
        const taskId = `t4-${RUN}`;
        await tryCompleteSdTicketMapping(makeTask(taskId, undefined), LIST_ID);
        assert.deepEqual(snapshotCounts(), before, "no ClickUp calls when request type unresolved");
        const rows = await getMappingFlags(isoDb, taskId);
        assert.equal(rows.length, 1, "mapping row still created");
        assert.equal(rows[0].template_checklist_applied, false, "unresolved type leaves flag untouched");
        ok("4: unresolvable request type → skip, zero API calls");
      }

      // ── 5. NoBull-native ticket → checklist yes, needs-info comment no ──
      {
        const taskId = `t5-${RUN}`;
        await isoDb.execute(sql`
          INSERT INTO sd_ticket_mapping
            (id, clickup_task_id, created_via_nobull, created_at, updated_at)
          VALUES (${`m5-${RUN}`}, ${taskId}, true, NOW(), NOW())
        `);
        const before = snapshotCounts();
        await tryCompleteSdTicketMapping(makeTask(taskId, { id: RT_OPT_TEMPLATED }), LIST_ID);
        const after = snapshotCounts();
        assert.equal(after.checklist, before.checklist + 1, "checklist still applied to NoBull-native ticket");
        assert.equal(after.items, before.items + 3, "all steps posted");
        assert.equal(after.comments, before.comments, "NO needs-info comment for NoBull-native ticket");
        assert.equal(after.updates, before.updates, "NO status transition for NoBull-native ticket");
        const rows = await getMappingFlags(isoDb, taskId);
        assert.equal(rows[0].template_checklist_applied, true, "checklist flag set");
        assert.equal(rows[0].needs_info_notified, false, "needs-info flag stays false");
        ok("5: created-via-NoBull ticket gets checklist but never the needs-info comment");
      }

      // ── 6. Task #5235: step assignees resolve on the worker apply path ──
      // Fixed user + Doer resolve via token rows; Checker resolves via the
      // department-member fallback.
      {
        const taskId = `t6-${RUN}`;
        const itemsBefore = cuCalls().createChecklistItem.length;
        const task = {
          id: taskId,
          custom_fields: [
            { id: FIELD_RT, value: { id: RT_OPT_ASSIGN } },
            { id: FIELD_CLIENT, value: { id: CLIENT_OPT } },
            { id: FIELD_DEPT, value: { id: DEPT_OPT } },
          ],
        };
        await tryCompleteSdTicketMapping(task, LIST_ID);

        const items = cuCalls().createChecklistItem.slice(itemsBefore) as Array<{
          body: { name: string; assignee?: number };
        }>;
        assert.deepEqual(
          items.map((i) => i.body.name),
          ["Fixed person step", "Doer step", "Checker step", "Plain step", "Other-dept doer step"],
          "all five steps posted in sort_order",
        );
        assert.deepEqual(
          items.map((i) => i.body.assignee),
          [80001, 80002, 80003, undefined, 80004],
          "fixed→token id, Doer→token id, Checker→department-member fallback id, plain step→unassigned, department-override Doer→other department's Doer",
        );
        const rows = await getMappingFlags(isoDb, taskId);
        assert.equal(rows[0].template_checklist_applied, true, "checklist apply completes");
        ok("6: fixed, Doer, and Checker step assignees resolve correctly");
      }
    },
    { tables: [...TABLES] },
  );

  console.log(`\nsd-template-enforcement: ${passed} assertion-groups passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAIL sd-template-enforcement:", err);
    process.exit(1);
  });
